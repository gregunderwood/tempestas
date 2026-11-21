#!/usr/bin/env python3
"""Drive the sandbox by hand with the real contract: a heartbeat to bind, then a fenced gpio/set.

A diagnostic, not a second brain: it never runs a rule and never decides anything.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta

import paho.mqtt.client as mqtt

ROOT = "tempestas/v1"
COMMAND_LIFETIME_SECONDS = 30
# The node binds on the heartbeat it just received, and judges the command against that binding.
BIND_SETTLE_SECONDS = 0.5
DELIVERY_SETTLE_SECONDS = 1.0
USAGE_ERROR = 2


def now_iso(offset_seconds: float = 0.0) -> str:
    moment = datetime.now(UTC) + timedelta(seconds=offset_seconds)
    return moment.isoformat().replace("+00:00", "Z")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="ctl")
    parser.add_argument("node")
    parser.add_argument("--pin", type=int, action="append", default=[])
    parser.add_argument("--level", type=int, action="append", default=[])
    parser.add_argument("--controller", default="sandbox-ctl")
    parser.add_argument("--epoch", type=int, default=1)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--user", default="tempestas-server")
    parser.add_argument("--password", default="sandbox")
    parser.add_argument("--heartbeat-only", action="store_true")
    return parser.parse_args()


def connect(arguments: argparse.Namespace) -> mqtt.Client:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"ctl-{uuid.uuid4().hex[:8]}")
    client.username_pw_set(arguments.user, arguments.password)
    client.connect(arguments.host, arguments.port, keepalive=30)
    client.loop_start()
    return client


def publish(client: mqtt.Client, topic: str, payload: dict) -> None:
    client.publish(topic, json.dumps(payload), qos=1).wait_for_publish()


def send_heartbeat(client: mqtt.Client, arguments: argparse.Namespace) -> None:
    heartbeat = {
        "schema": "heartbeat/1",
        "ts": now_iso(),
        "controller": arguments.controller,
        "epoch": arguments.epoch,
    }
    publish(client, f"{ROOT}/node/{arguments.node}/control/heartbeat", heartbeat)
    print(f"heartbeat -> {arguments.node} as {arguments.controller} epoch {arguments.epoch}")


def send_gpio_set(client: mqtt.Client, arguments: argparse.Namespace) -> None:
    command = {
        "schema": "gpioSet/1",
        "id": str(uuid.uuid4()),
        "ts": now_iso(),
        "issuedBy": arguments.controller,
        "epoch": arguments.epoch,
        "expiresAt": now_iso(COMMAND_LIFETIME_SECONDS),
        "lines": [
            {"pin": pin, "level": level}
            for pin, level in zip(arguments.pin, arguments.level, strict=False)
        ],
    }
    publish(client, f"{ROOT}/node/{arguments.node}/gpio/set", command)
    print(f"gpio/set  -> {arguments.node} {command['lines']}")


def main() -> int:
    arguments = parse_arguments()
    if len(arguments.pin) != len(arguments.level) and not arguments.heartbeat_only:
        print("each --pin needs a --level", file=sys.stderr)
        return USAGE_ERROR

    client = connect(arguments)
    send_heartbeat(client, arguments)
    if not arguments.heartbeat_only:
        time.sleep(BIND_SETTLE_SECONDS)
        send_gpio_set(client, arguments)

    time.sleep(DELIVERY_SETTLE_SECONDS)
    client.loop_stop()
    client.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
