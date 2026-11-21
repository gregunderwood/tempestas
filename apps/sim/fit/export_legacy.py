"""Pull the canopy sensor's readings out of the legacy Flask database; see README.md.

python fit/export_legacy.py --from 2026-09-23 --to 2026-09-25 -o canopy.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

CONTAINER = "environment-controller-api-db-1"
TZ = "America/Vancouver"
COLUMNS_PER_ROW = 4

QUERY = """
select to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.MS'),
       co2, temperature, humidity
from sensor_reading
where created_at >= '{start} 00:00 {tz}'
  and created_at <  '{end} 00:00 {tz}'
  and co2 is not null
order by created_at
"""


def run_remote_query(host: str, start: str, end: str) -> str:
    sql = QUERY.format(start=start, end=end, tz=TZ).replace("\n", " ").strip()
    command = [
        "ssh",
        "-o",
        "ConnectTimeout=30",
        host,
        f"docker exec {CONTAINER} psql -U postgres -d econ -At -F'|' -c \"{sql}\"",
    ]
    return subprocess.run(command, capture_output=True, text=True, check=True).stdout


def parse_optional_float(text: str) -> float | None:
    return float(text) if text else None


def to_reading(timestamp: str, co2: str, temperature: str, humidity: str) -> dict:
    return {
        "nodeId": "greenhouse",
        "sensorId": "canopy",
        # Built here, not in to_char: quoted literals do not survive the ssh round-trip.
        "createdAt": timestamp.replace(" ", "T") + "Z",
        "co2": int(co2),
        "temperature": parse_optional_float(temperature),
        "humidity": parse_optional_float(humidity),
    }


def fetch(host: str, start: str, end: str) -> list[dict]:
    rows = (line.split("|") for line in run_remote_query(host, start, end).splitlines())
    return [to_reading(*row) for row in rows if len(row) == COLUMNS_PER_ROW]


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--host", default="greenhouse")
    parser.add_argument("--from", dest="start", required=True, help="local date, inclusive")
    parser.add_argument("--to", dest="end", required=True, help="local date, exclusive")
    parser.add_argument("-o", "--out", required=True)
    arguments = parser.parse_args()

    readings = fetch(arguments.host, arguments.start, arguments.end)
    if not readings:
        print("no readings in that range", file=sys.stderr)
        return 1

    with open(arguments.out, "w") as out_file:
        json.dump(readings, out_file)
    print(f"{len(readings)} readings  {readings[0]['createdAt']} -> {readings[-1]['createdAt']}")
    print(f"written to {arguments.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
