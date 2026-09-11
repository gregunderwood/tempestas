#!/usr/bin/env python3
"""Drive the sandbox by hand: a minimal controller, for use before the server is wired in.

Speaks the real contract - heartbeat to bind, then a fenced gpio/set - so what
it proves about the agents is what the server will find. It is a diagnostic,
not a second brain: it never runs a rule and never decides anything.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

import paho.mqtt.client as mqtt

ROOT = "tempestas/v1"


def now_iso(delta_s: float = 0.0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=delta_s)).isoformat().replace(
        "+00:00", "Z"
    )


def main() -> int:
    p = argparse.ArgumentParser(prog="ctl")
    p.add_argument("node")
    p.add_argument("--pin", type=int, action="append", default=[])
    p.add_argument("--level", type=int, action="append", default=[])
    p.add_argument("--controller", default="sandbox-ctl")
    p.add_argument("--epoch", type=int, default=1)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--user", default="tempestas-server")
    p.add_argument("--password", default="sandbox")
    p.add_argument("--heartbeat-only", action="store_true")
    args = p.parse_args()

    if len(args.pin) != len(args.level) and not args.heartbeat_only:
        print("each --pin needs a --level", file=sys.stderr)
        return 2

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"ctl-{uuid.uuid4().hex[:8]}")
    c.username_pw_set(args.user, args.password)
    c.connect(args.host, args.port, keepalive=30)
    c.loop_start()

    hb = {
        "schema": "heartbeat/1",
        "ts": now_iso(),
        "controller": args.controller,
        "epoch": args.epoch,
    }
    c.publish(f"{ROOT}/node/{args.node}/control/heartbeat", json.dumps(hb), qos=1).wait_for_publish()
    print(f"heartbeat -> {args.node} as {args.controller} epoch {args.epoch}")

    if not args.heartbeat_only:
        # The node binds on the heartbeat it just received; give it a moment
        # before a command that will be judged against that binding.
        time.sleep(0.5)
        cmd = {
            "schema": "gpioSet/1",
            "id": str(uuid.uuid4()),
            "ts": now_iso(),
            "issuedBy": args.controller,
            "epoch": args.epoch,
            # A command that outlives its usefulness is a command that can be
            # replayed at the wrong moment.
            "expiresAt": now_iso(30),
            "lines": [{"pin": p_, "level": l_} for p_, l_ in zip(args.pin, args.level)],
        }
        c.publish(f"{ROOT}/node/{args.node}/gpio/set", json.dumps(cmd), qos=1).wait_for_publish()
        print(f"gpio/set  -> {args.node} {cmd['lines']}")

    time.sleep(1.0)
    c.loop_stop()
    c.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
