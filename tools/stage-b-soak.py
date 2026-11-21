#!/usr/bin/env python3
"""Soak logger: elantris beside the greenhouse's legacy stream, one CSV row a minute.

Temporary; delete it and its unit once the soak is read (docs/Pumphouse.md).

    python3 tools/stage-b-soak.py --out /var/log/tempestas/stage-b-soak.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
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
LEGACY_TIMEOUT_SECONDS = 8
STOP_POLLS_PER_SECOND = 10
CSV_HEADER = [
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

latest: dict[str, float | None] = {"temp": None, "rh": None, "co2": None, "age": None}
last_seen: float | None = None


def read_valid(measurement: dict) -> float | None:
    return measurement["value"] if measurement["valid"] else None


def on_message(_client, _userdata, message) -> None:
    global last_seen
    try:
        measurements = json.loads(message.payload)["measurements"]
    except (ValueError, KeyError):
        return
    latest["temp"] = read_valid(measurements["tempC"])
    latest["rh"] = read_valid(measurements["humidityPct"])
    latest["co2"] = read_valid(measurements["co2Ppm"])
    last_seen = time.monotonic()


def fetch_legacy() -> dict[str, float | None]:
    """The old system's newest reading. Never fatal: a gap is data too."""
    try:
        with urllib.request.urlopen(LEGACY_URL, timeout=LEGACY_TIMEOUT_SECONDS) as response:
            reading = json.load(response)["reading"]
        return {
            "temp": reading.get("temperature"),
            "rh": reading.get("humidity"),
            "co2": reading.get("co2"),
            # Naive and zone-ambiguous, so carried verbatim rather than guessed at.
            "ts": reading.get("created_at"),
        }
    except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
        return {"temp": None, "rh": None, "co2": None, "ts": None}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--broker", default="127.0.0.1")
    # From the environment, so the credential never lands in `ps` or a unit file.
    parser.add_argument("--username", default=os.environ.get("MQTT_USERNAME"))
    parser.add_argument("--password", default=os.environ.get("MQTT_PASSWORD"))
    parser.add_argument("--interval", type=float, default=60.0)
    return parser.parse_args()


def connect(arguments: argparse.Namespace) -> mqtt.Client:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="stage-b-soak")
    client.on_message = on_message
    client.on_connect = lambda connected_client, *_: connected_client.subscribe(TOPIC, qos=0)
    if arguments.username:
        client.username_pw_set(arguments.username, arguments.password or None)
    client.connect(arguments.broker, 1883, keepalive=30)
    client.loop_start()
    return client


def build_row() -> list:
    legacy = fetch_legacy()
    age = None if last_seen is None else round(time.monotonic() - last_seen, 1)
    return [
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


def main() -> int:
    arguments = parse_arguments()
    path = Path(arguments.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    is_new_file = not path.exists() or path.stat().st_size == 0

    client = connect(arguments)

    is_stopping = False

    def stop(*_) -> None:
        nonlocal is_stopping
        is_stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    with path.open("a", newline="") as handle:
        writer = csv.writer(handle)
        if is_new_file:
            writer.writerow(CSV_HEADER)
            handle.flush()

        while not is_stopping:
            writer.writerow(build_row())
            handle.flush()
            for _ in range(int(arguments.interval * STOP_POLLS_PER_SECOND)):
                if is_stopping:
                    break
                time.sleep(1 / STOP_POLLS_PER_SECOND)

    client.loop_stop()
    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
