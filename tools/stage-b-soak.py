#!/usr/bin/env python3
"""Stage B soak logger: elantris beside the greenhouse, one CSV row a minute.

Temporary. Stage B step 4 runs the new sensor for 48h against the greenhouse's
live stream and asks whether the SHAPE and the CO2 baseline track - they are in
different rooms, so the absolute temperatures will not match and are not
supposed to. The output is what `temperature_offset_c` gets tuned from.

Delete this, and its unit, once the soak is read.

    python3 tools/stage-b-soak.py --out /var/log/tempestas/stage-b-soak.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import signal
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

import paho.mqtt.client as mqtt

LEGACY_URL = "http://greenhouse/api/sensor_readings/latest"
TOPIC = "tempestas/v1/node/+/sensor/+/sample"

latest: dict[str, float | None] = {"temp": None, "rh": None, "co2": None, "age": None}
last_seen: float | None = None


def on_message(_client, _userdata, msg):
    global last_seen
    try:
        body = json.loads(msg.payload)
        m = body["measurements"]
    except (ValueError, KeyError):
        return
    latest["temp"] = m["tempC"]["value"] if m["tempC"]["valid"] else None
    latest["rh"] = m["humidityPct"]["value"] if m["humidityPct"]["valid"] else None
    latest["co2"] = m["co2Ppm"]["value"] if m["co2Ppm"]["valid"] else None
    last_seen = time.monotonic()


def fetch_legacy() -> dict[str, float | None]:
    """The old system's newest reading. Never fatal: a gap is data too."""
    try:
        with urllib.request.urlopen(LEGACY_URL, timeout=8) as response:
            reading = json.load(response)["reading"]
        return {
            "temp": reading.get("temperature"),
            "rh": reading.get("humidity"),
            "co2": reading.get("co2"),
            # The old wire format: "%m/%d/%Y, %H:%M:%S", naive and ambiguous.
            # Carried through verbatim rather than parsed - guessing its zone is
            # the bug the new system exists to avoid.
            "ts": reading.get("created_at"),
        }
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
        return {"temp": None, "rh": None, "co2": None, "ts": None}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--broker", default="127.0.0.1")
    parser.add_argument("--interval", type=float, default=60.0)
    args = parser.parse_args()

    path = Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    new_file = not path.exists() or path.stat().st_size == 0

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage-b-soak")
    client.on_message = on_message
    client.on_connect = lambda c, *_: c.subscribe(TOPIC, qos=0)
    client.connect(args.broker, 1883, keepalive=30)
    client.loop_start()

    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    with path.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if new_file:
            writer.writerow(
                [
                    "utc",
                    "elantris_temp_c",
                    "elantris_rh_pct",
                    "elantris_co2_ppm",
                    "elantris_sample_age_s",
                    "greenhouse_temp_c",
                    "greenhouse_rh_pct",
                    "greenhouse_co2_ppm",
                    "greenhouse_ts_naive",
                ]
            )
            handle.flush()

        while not stopping:
            legacy = fetch_legacy()
            age = None if last_seen is None else round(time.monotonic() - last_seen, 1)
            writer.writerow(
                [
                    datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
                    latest["temp"],
                    latest["rh"],
                    latest["co2"],
                    age,
                    legacy["temp"],
                    legacy["rh"],
                    legacy["co2"],
                    legacy["ts"],
                ]
            )
            handle.flush()  # a soak that loses its tail to a buffer is no soak
            for _ in range(int(args.interval * 10)):
                if stopping:
                    break
                time.sleep(0.1)

    client.loop_stop()
    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
