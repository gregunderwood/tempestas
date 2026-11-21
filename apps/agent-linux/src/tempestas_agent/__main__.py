"""Run the agent.

    tempestas-agent --config /etc/tempestas/agent.toml
    tempestas-agent --simulated            # no hardware needed at all

Logs go to stdout as one line per event and this process owns no files: the old
system's 5.4GB debug log grew because the app owned its own file and nothing
capped it. journald caps itself; see docs/Roadmap.md.
"""

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
from .config import ConfigError, load
from .runtime import AlreadyRunning, SingleInstance, sd_notify

log = logging.getLogger("tempestas.agent")


def build_client(agent: Agent) -> mqtt.Client:
    cfg = agent.config
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"tempestas-{cfg.node_id}",
        # A persistent session is precisely a queue of commands waiting to
        # replay on reconnect. For a relay that may be holding a burner, that
        # is a hazard rather than a convenience.
        clean_session=True,
    )
    if cfg.mqtt.username:
        client.username_pw_set(cfg.mqtt.username, cfg.mqtt.password or None)

    qos, retain = contract.QOS["status"]
    client.will_set(
        contract.build_status_topic(cfg.node_id),
        json.dumps(agent.status_payload("offline")),
        qos=qos,
        retain=retain,
    )
    return client


def wire(agent: Agent, client: mqtt.Client) -> None:
    cfg = agent.config

    def on_connect(_client, _userdata, _flags, reason_code, _properties=None):
        if reason_code != 0:
            log.error("connect refused: %s", reason_code)
            return
        log.info("connected to %s as %s", cfg.mqtt.url, cfg.node_id)

        qos, retain = contract.QOS["status"]
        client.publish(
            contract.build_status_topic(cfg.node_id),
            json.dumps(agent.status_payload("online")),
            qos=qos,
            retain=retain,
        )
        hqos, hretain = contract.QOS["hello"]
        client.publish(
            contract.build_hello_topic(cfg.node_id),
            json.dumps(agent.hello_payload()),
            qos=hqos,
            retain=hretain,
        )
        # The retained gpio/state is what a controller reads to reconcile, so it
        # has to be republished on every connect. Without this, a controller
        # that restarts reads whatever was last retained - which after an agent
        # restart is the level from BEFORE the restart, not the failsafe the
        # claim just applied.
        agent.publish_gpio_state(cfg.gpio.lines)

        client.subscribe(
            [
                (contract.build_gpio_set_topic(cfg.node_id), 1),
                (contract.build_gpio_sync_topic(cfg.node_id), 1),
                (contract.build_heartbeat_topic(cfg.node_id), 0),
                (contract.SERVER_STATUS_TOPIC, 1),
            ]
        )

    def on_message(_client, _userdata, msg):
        topic = msg.topic
        if topic == contract.build_heartbeat_topic(cfg.node_id):
            agent.on_heartbeat(msg.payload)
            return
        if topic == contract.SERVER_STATUS_TOPIC:
            _on_server_status(agent, msg.payload)
            return
        if topic == contract.build_gpio_set_topic(cfg.node_id):
            result = agent.on_command(msg.payload, retained=bool(msg.retain))
            if result is None:
                return
            rqos, rretain = contract.QOS["gpioResult"]
            client.publish(
                contract.build_gpio_result_topic(cfg.node_id),
                json.dumps(result),
                qos=rqos,
                retain=rretain,
            )
            agent.publish_gpio_state(line["pin"] for line in result["lines"])

    client.on_connect = on_connect
    client.on_message = on_message


def _on_server_status(agent: Agent, payload: bytes) -> None:
    """The server's own LWT. When the brain dies, do not wait for the dead-man."""
    try:
        body = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return
    if body.get("state") == "offline":
        log.error("the server reported itself OFFLINE - entering failsafe now")
        agent.enter_failsafe(contract.AlarmCode.SAFE_STATE_ENTERED, "server published offline")


def main() -> int:
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
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
    )

    try:
        config = load(args.config)
    except ConfigError as err:
        log.error("refusing to start: %s", err)
        return 2

    # Before anything is opened or announced: two agents on one node_id fight
    # over the same MQTT client id, and that reads in the server's log as a node
    # rebooting in a loop rather than as the misconfiguration it is.
    lock_path = args.lock_file or f"/run/tempestas/agent-{config.node_id}.lock"
    lock = SingleInstance(lock_path)
    try:
        lock.acquire()
    except (AlreadyRunning, OSError) as err:
        log.error("refusing to start: %s", err)
        return 3

    sensor, gpio = build_backends(config, simulated=args.simulated)
    agent = Agent(config, client=None, sensor=sensor, gpio=gpio)
    client = build_client(agent)
    agent.client = client
    wire(agent, client)

    # Start BEFORE describing: the serial and the applied temperature offset are
    # only known once the chip has been talked to, and they are the two things
    # worth having in the log when a reading later looks wrong.
    sensor.start()
    log.info("node=%s sensor=%s gpio=%s", config.node_id, sensor.describe(), gpio.describe())
    if not config.has_gpio:
        log.info("no GPIO lines configured: this agent cannot drive a pin at all")
    client.connect(config.mqtt.host, config.mqtt.port, keepalive=config.mqtt.keepalive_s)
    client.loop_start()

    # Readiness is a fact, so report it rather than making whatever is ordered
    # after this unit guess with a sleep - which is what the old system did.
    sd_notify("READY=1")

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    try:
        while not stopping:
            for sensor_id, reading in sensor.read_all():
                qos, retain = contract.QOS["sample"]
                client.publish(
                    contract.build_sample_topic(config.node_id, sensor_id),
                    json.dumps(agent.sample_payload(sensor_id, reading)),
                    qos=qos,
                    retain=retain,
                )
            agent.check_deadman()
            time.sleep(config.sensor.sample_interval_s)
    finally:
        sd_notify("STOPPING=1")
        # MQTT suppresses the will on a graceful disconnect, so say it ourselves
        # or this node is left looking online forever.
        qos, retain = contract.QOS["status"]
        client.publish(
            contract.build_status_topic(config.node_id),
            json.dumps(agent.status_payload("offline")),
            qos=qos,
            retain=retain,
        )
        time.sleep(0.2)
        client.loop_stop()
        client.disconnect()
        sensor.stop()
        gpio.close()
        lock.release()
        log.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
