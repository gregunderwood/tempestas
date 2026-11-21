"""Run the agent: `tempestas-agent --config <agent.toml>`, or `--simulated` with no hardware."""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
import time

import paho.mqtt.client as mqtt

from . import contract
from .agent import Agent, build_backends
from .config import AgentConfig, ConfigError, load
from .runtime import AlreadyRunning, SingleInstance, sd_notify

log = logging.getLogger("tempestas.agent")

EXIT_OK = 0
EXIT_BAD_CONFIG = 2
EXIT_ALREADY_RUNNING = 3
CONNECT_ACCEPTED = 0
LOCK_PATH_TEMPLATE = "/run/tempestas/agent-{node_id}.lock"
LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)s %(message)s"
# Gives the network loop time to send the offline status before it stops.
OFFLINE_FLUSH_S = 0.2


def main() -> int:
    arguments = parse_arguments()
    configure_logging(arguments.log_level)

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
    agent = Agent(config, client=None, sensor=sensor, gpio=gpio)
    client = build_client(agent)
    agent.client = client
    wire(agent, client)

    start(agent, config)
    sd_notify("READY=1")
    try:
        run_until_signalled(agent, config)
    finally:
        shut_down(agent, lock)
    return EXIT_OK


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
        (contract.SERVER_STATUS_TOPIC, contract.QOS["serverStatus"][0]),
    ]


def wire(agent: Agent, client: mqtt.Client) -> None:
    config = agent.config
    handlers = {
        contract.build_heartbeat_topic(config.node_id): handle_heartbeat,
        contract.SERVER_STATUS_TOPIC: handle_server_status,
        contract.build_gpio_set_topic(config.node_id): handle_gpio_set,
    }

    def on_connect(_client, _userdata, _flags, reason_code, _properties=None):
        if reason_code != CONNECT_ACCEPTED:
            log.error("connect refused: %s", reason_code)
            return
        log.info("connected to %s as %s", config.mqtt.url, config.node_id)
        announce(agent)
        client.subscribe(build_subscriptions(config.node_id))

    def on_message(_client, _userdata, message):
        handler = handlers.get(message.topic)
        if handler is not None:
            handler(agent, message)

    client.on_connect = on_connect
    client.on_message = on_message


def announce(agent: Agent) -> None:
    node_id = agent.config.node_id
    agent.publish("status", contract.build_status_topic(node_id), agent.status_payload("online"))
    agent.say_hello()
    # Retained, so a restarting controller would otherwise read the level from before our restart.
    agent.publish_gpio_state(agent.config.gpio.lines)


def handle_heartbeat(agent: Agent, message) -> None:
    agent.on_heartbeat(message.payload)


def handle_gpio_set(agent: Agent, message) -> None:
    result = agent.on_command(message.payload, retained=bool(message.retain))
    if result is None:
        return
    agent.publish("gpioResult", contract.build_gpio_result_topic(agent.config.node_id), result)
    agent.publish_gpio_state(line["pin"] for line in result["lines"])


def handle_server_status(agent: Agent, message) -> None:
    agent.on_server_status(message.payload, retained=bool(message.retain))


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
    agent.client.connect(config.mqtt.host, config.mqtt.port, keepalive=config.mqtt.keepalive_s)
    agent.client.loop_start()


def run_until_signalled(agent: Agent, config: AgentConfig) -> None:
    should_stop = False

    def request_stop(_signal_number, _frame):
        nonlocal should_stop
        should_stop = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    while not should_stop:
        publish_samples(agent)
        agent.check_deadman()
        time.sleep(config.sensor.sample_interval_s)


def publish_samples(agent: Agent) -> None:
    node_id = agent.config.node_id
    for sensor_id, reading in agent.sensor.read_all():
        agent.publish(
            "sample",
            contract.build_sample_topic(node_id, sensor_id),
            agent.sample_payload(sensor_id, reading),
        )


def shut_down(agent: Agent, lock: SingleInstance) -> None:
    sd_notify("STOPPING=1")
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
