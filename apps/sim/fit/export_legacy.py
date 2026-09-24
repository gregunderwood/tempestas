"""Pull canopy-sensor readings out of the legacy Flask database.

The greenhouse Pi still runs the old environment-controller, whose Postgres
holds one sensor's history back to 2025-08-23 - the SCD41 sitting under the
canopy. That is the sensor worth fitting against: elantris is by the north
entrance in its own microclimate, and its SCD4x has been degrading.

The legacy schema has no node or sensor rows, just `sensor_reading` with a
null `sensor_id`, so there is nothing to filter on.

    python fit/export_legacy.py --from 2026-09-23 --to 2026-09-25 -o canopy.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

CONTAINER = "environment-controller-api-db-1"
TZ = "America/Vancouver"

QUERY = """
select to_char(created_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.MS'),
       co2, temperature, humidity
from sensor_reading
where created_at >= '{start} 00:00 {tz}'
  and created_at <  '{end} 00:00 {tz}'
  and co2 is not null
order by created_at
"""


def fetch(host: str, start: str, end: str) -> list[dict]:
    sql = QUERY.format(start=start, end=end, tz=TZ).replace("\n", " ").strip()
    cmd = ["ssh", "-o", "ConnectTimeout=30", host,
           f"docker exec {CONTAINER} psql -U postgres -d econ -At -F'|' -c \"{sql}\""]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout

    rows = []
    for line in out.splitlines():
        parts = line.split("|")
        if len(parts) != 4:
            continue
        ts, co2, temp, rh = parts
        # assembled here, not in to_char: quoted literals in the format string
        # do not survive the shell round-trip through ssh
        ts = ts.replace(" ", "T") + "Z"
        rows.append({
            "nodeId": "greenhouse",
            "sensorId": "canopy",
            "createdAt": ts,
            "co2": int(co2),
            "temperature": float(temp) if temp else None,
            "humidity": float(rh) if rh else None,
        })
    return rows


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="greenhouse")
    p.add_argument("--from", dest="start", required=True, help="local date, inclusive")
    p.add_argument("--to", dest="end", required=True, help="local date, exclusive")
    p.add_argument("-o", "--out", required=True)
    args = p.parse_args()

    rows = fetch(args.host, args.start, args.end)
    if not rows:
        print("no readings in that range", file=sys.stderr)
        return 1

    with open(args.out, "w") as fh:
        json.dump(rows, fh)
    print(f"{len(rows)} readings  {rows[0]['createdAt']} -> {rows[-1]['createdAt']}")
    print(f"written to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
