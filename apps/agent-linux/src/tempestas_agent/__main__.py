"""Run the agent: `tempestas-agent --config <agent.toml>`, or `--simulated` with no hardware."""

from __future__ import annotations

import argparse
import faulthandler
import json
import logging
import math
import os
import signal
import sys
import threading
import time

import paho.mqtt.client as mqtt

from . import contract
from .agent import Agent, build_backends
from .config import AgentConfig, ConfigError, load
from .release_layout import ReleaseLayout
from .runtime import AlreadyRunning, SingleInstance, sd_notify

log = logging.getLogger("tempestas.agent")

EXIT_OK = 0
EXIT_BAD_CONFIG = 2
EXIT_ALREADY_RUNNING = 3
# The unit's RestartForceExitStatus: systemd starts whatever `current` now points at.
EXIT_RESTART_FOR_UPDATE = 75
CONNECT_ACCEPTED = 0
LOCK_PATH_TEMPLATE = "/run/tempestas/agent-{node_id}.lock"
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s %(message)s"
# Gives the network loop time to send the offline status before it stops.
OFFLINE_FLUSH_S = 0.2
# A signal handler cannot safely wake an Event, so a stop is noticed within this.
STOP_CHECK_S = 1.0
# systemd asks for a ping at least every half of WatchdogSec.
WATCHDOG_PING_SHARE = 0.5
MICROSECONDS_PER_SECOND = 1_000_000


def main() -> int:
    arguments = parse_arguments()
    configure_logging(arguments.log_level)
    # The watchdog kills a hung agent with SIGABRT; this writes where it hung to the journal.
    faulthandler.enable()

    try:
        config = load(arguments.config)
    except ConfigError as error:
        log.error("refusing to start: %s", error)
        return EXIT_BAD_CONFIG

    # Before anything is opened or announced: two agents on one node_id read as a reboot loop.
    lock = SingleInstance(arguments.lock_file or LOCK_PATH_TEMPLATE.format(node_id=config.node_id))
    try:
        lock.acquire()
    except (AlreadyRunning, OSError) as error:
        log.error("refusing to start: %s", error)
        return EXIT_ALREADY_RUNNING

    sensor, gpio = build_backends(config, simulated=arguments.simulated)
    agent = Agent(
        config, client=None, sensor=sensor, gpio=gpio, layout=ReleaseLayout.from_environment()
    )
    agent.settle_update()
    # Before connecting, so no download of this run can be mistaken for an abandoned one.
    agent.remove_unfinished_downloads()
    client = build_client(agent)
    agent.client = client
    wire(agent, client)

    start(agent, config)
    sd_notify("READY=1")
    try:
        run_until_signalled(agent, config)
    except Exception:
        # After an update switched `current`, any other exit reads as the new release failing.
        if not agent.restart_requested.is_set():
            raise
        log.exception("the agent failed after an update was installed; restarting into it")
    finally:
        shut_down_without_raising(agent, lock)
    return EXIT_RESTART_FOR_UPDATE if agent.restart_requested.is_set() else EXIT_OK


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="tempestas-agent")
    parser.add_argument("--config", help="path to agent.toml")
    parser.add_argument(
        "--simulated",
        action="store_true",
        help="fake sensor and GPIO; needs no hardware and touches no chip",
    )
    parser.add_argument("--log-level", default="INFO")
    parser.add_argument(
        "--lock-file",
        default=None,
        help="advisory lock path (default /run/tempestas/agent-<node>.lock)",
    )
    return parser.parse_args()


def configure_logging(level: str) -> None:
    logging.basicConfig(level=level.upper(), format=LOG_FORMAT)


def build_client(agent: Agent) -> mqtt.Client:
    config = agent.config
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"tempestas-{config.node_id}",
        # A persistent session would replay queued commands to a relay on reconnect.
        clean_session=True,
    )
    if config.mqtt.username:
        client.username_pw_set(config.mqtt.username, config.mqtt.password or None)

    qos, retain = contract.QOS["status"]
    client.will_set(
        contract.build_status_topic(config.node_id),
        json.dumps(agent.status_payload("offline")),
        qos=qos,
        retain=retain,
    )
    return client


def build_subscriptions(node_id: str) -> list[tuple[str, int]]:
    return [
        (contract.build_gpio_set_topic(node_id), contract.QOS["gpioSet"][0]),
        (contract.build_gpio_sync_topic(node_id), contract.QOS["gpioSync"][0]),
        (contract.build_heartbeat_topic(node_id), contract.QOS["heartbeat"][0]),
        (contract.build_update_topic(node_id), contract.QOS["update"][0]),
        (contract.SERVER_STATUS_TOPIC, contract.QOS["serverStatus"][0]),
    ]


def wire(agent: Agent, client: mqtt.Client) -> None:
    config = agent.config
    handlers = {
        contract.build_heartbeat_topic(config.node_id): handle_heartbeat,
        contract.SERVER_STATUS_TOPIC: handle_server_status,
        contract.build_gpio_set_topic(config.node_id): handle_gpio_set,
        contract.build_update_topic(config.node_id): handle_update,
    }

    def on_connect(_client, _userdata, _flags, reason_code, _properties=None):
        if reason_code != CONNECT_ACCEPTED:
            log.error("connect refused: %s", reason_code)
            return
        log.info("connected to %s as %s", config.mqtt.url, config.node_id)
        agent.on_connected()
        announce(agent)
        client.subscribe(build_subscriptions(config.node_id))

    def on_message(_client, _userdata, message):
        handler = handlers.get(message.topic)
        if handler is not None:
            handler(agent, message)

    def on_disconnect(_client, _userdata, _flags, _reason_code, _properties=None):
        agent.on_disconnected()

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message


def announce(agent: Agent) -> None:
    node_id = agent.config.node_id
    agent.publish("status", contract.build_status_topic(node_id), agent.status_payload("online"))
    agent.say_hello()
    # Retained, so a restarting controller would otherwise read the level from before our restart.
    agent.publish_gpio_state(agent.config.gpio.lines)
    agent.report_settled_update()


def handle_heartbeat(agent: Agent, message) -> None:
    agent.on_heartbeat(message.payload)


def handle_gpio_set(agent: Agent, message) -> None:
    result = agent.on_command(message.payload, is_retained=bool(message.retain))
    if result is None:
        return
    agent.publish("gpioResult", contract.build_gpio_result_topic(agent.config.node_id), result)
    agent.publish_gpio_state(line["pin"] for line in result["lines"])


def handle_update(agent: Agent, message) -> None:
    agent.on_update(message.payload, is_retained=bool(message.retain))


def handle_server_status(agent: Agent, message) -> None:
    agent.on_server_status(message.payload, is_retained=bool(message.retain))


def start(agent: Agent, config: AgentConfig) -> None:
    # Started before describing: the serial and applied offset are only known once it has run.
    agent.sensor.start()
    log.info(
        "node=%s sensor=%s gpio=%s",
        config.node_id,
        agent.sensor.describe(),
        agent.gpio.describe(),
    )
    if not config.has_gpio:
        log.info("no GPIO lines configured: this agent cannot drive a pin at all")
    # Async, so a broker down at start is retried rather than failing a new release before hello.
    broker = config.mqtt
    agent.client.connect_async(broker.host, broker.port, keepalive=broker.keepalive_s)
    agent.client.loop_start()
    # Kept here: paho keeps it private, and forgets it once a raising callback has ended it.
    agent.network_thread = getattr(agent.client, "_thread", None)


def run_until_signalled(agent: Agent, config: AgentConfig) -> None:
    stop = StopRequest()
    signal.signal(signal.SIGINT, stop.request)
    signal.signal(signal.SIGTERM, stop.request)
    ping_interval_s = read_watchdog_ping_interval_s()

    while not stop.is_requested and not agent.restart_requested.is_set():
        require_network_loop_alive(agent.network_thread)
        publish_samples(agent)
        agent.check_deadman()
        agent.tend_update()
        wait_for_next_tick(agent, config.sensor.sample_interval_s, ping_interval_s, stop)


class NetworkLoopDied(RuntimeError):
    """A failed run: systemd restarts the agent, and OnFailure judges an update on its gate."""


def require_network_loop_alive(network_thread: threading.Thread | None) -> None:
    # A callback that raises ends paho's thread for good, leaving an agent that cannot hear.
    if network_thread is not None and not network_thread.is_alive():
        raise NetworkLoopDied("the MQTT network thread died, so this agent can no longer hear")


class StopRequest:
    """Set by a signal handler, which takes no lock: it may interrupt a thread holding one."""

    def __init__(self):
        self.is_requested = False

    def request(self, _signal_number=None, _frame=None) -> None:
        self.is_requested = True


def read_watchdog_ping_interval_s() -> float | None:
    """None unless systemd watches this very process."""
    watchdog_pid = os.environ.get("WATCHDOG_PID")
    if watchdog_pid and watchdog_pid != str(os.getpid()):
        return None
    try:
        timeout_us = int(os.environ.get("WATCHDOG_USEC", ""))
    except ValueError:
        return None
    if timeout_us <= 0:
        return None
    return timeout_us / MICROSECONDS_PER_SECOND * WATCHDOG_PING_SHARE


def wait_for_next_tick(
    agent: Agent, interval_s: float, ping_interval_s: float | None, stop: StopRequest
) -> None:
    """Pings the watchdog through the wait, so only a pass of the loop that hangs trips it."""
    deadline = time.monotonic() + interval_s
    next_ping_at = time.monotonic() if ping_interval_s is not None else math.inf
    while not agent.wake_main_loop.is_set() and not stop.is_requested:
        now = time.monotonic()
        if ping_interval_s is not None and now >= next_ping_at:
            sd_notify("WATCHDOG=1")
            next_ping_at = now + ping_interval_s
        remaining_s = deadline - now
        if remaining_s <= 0:
            return
        agent.wake_main_loop.wait(min(remaining_s, next_ping_at - now, STOP_CHECK_S))


def publish_samples(agent: Agent) -> None:
    node_id = agent.config.node_id
    for sensor_id, reading in agent.sensor.read_all():
        agent.publish(
            "sample",
            contract.build_sample_topic(node_id, sensor_id),
            agent.sample_payload(sensor_id, reading),
        )


def shut_down_without_raising(agent: Agent, lock: SingleInstance) -> None:
    # A requested restart must still exit 75, or the rollback unit reads it as the update failing.
    try:
        shut_down(agent, lock)
    except Exception:
        if not agent.restart_requested.is_set():
            raise
        log.exception("the agent did not shut down cleanly")


def shut_down(agent: Agent, lock: SingleInstance) -> None:
    sd_notify("STOPPING=1")
    agent.stop_updates()
    # MQTT suppresses the will on a graceful disconnect, so say it ourselves.
    agent.publish(
        "status",
        contract.build_status_topic(agent.config.node_id),
        agent.status_payload("offline"),
    )
    time.sleep(OFFLINE_FLUSH_S)
    agent.client.loop_stop()
    agent.client.disconnect()
    agent.sensor.stop()
    agent.gpio.close()
    lock.release()
    log.info("stopped")


if __name__ == "__main__":
    sys.exit(main())
