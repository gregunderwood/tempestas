#!/usr/bin/env python3
"""Is this SCD4x healthy? Ask the chip, not the data.

    sudo systemctl stop tempestas-agent
    uv run python tools/scd4x_check.py
    sudo systemctl start tempestas-agent

Runs the chip's own self-test, reports what configuration actually took, and
samples for a while so intermittent faults have a chance to show. Use it on a
sensor that is behaving oddly, and on every new sensor before it is trusted.

Needs exclusive access to the bus: the SCD4x answers one reader, and two
processes polling it interleave into nonsense. It refuses to run while the
agent holds the sensor rather than producing a confusing answer.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

sys.path.insert(0, str(__file__.rsplit("/tools/", 1)[0] + "/src"))

from tempestas_agent.sensor import Scd4xSensor  # noqa: E402


def agent_is_running() -> bool:
    try:
        out = subprocess.run(
            ["systemctl", "is-active", "tempestas-agent"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() == "active"
    except Exception:
        return False


def main() -> int:
    p = argparse.ArgumentParser(prog="scd4x_check")
    p.add_argument("--bus", type=int, default=1)
    p.add_argument("--address", type=lambda s: int(s, 0), default=0x62)
    p.add_argument("--samples", type=int, default=30, help="10 s apart")
    p.add_argument("--co2-min", type=int, default=400)
    p.add_argument("--co2-max", type=int, default=5000)
    p.add_argument("--skip-self-test", action="store_true")
    p.add_argument("--force", action="store_true", help="run even if the agent is up")
    args = p.parse_args()

    if agent_is_running() and not args.force:
        print("tempestas-agent is ACTIVE. It owns the sensor, and two readers")
        print("interleave into nonsense. Stop it first:")
        print("  sudo systemctl stop tempestas-agent")
        return 2

    sensor = Scd4xSensor(
        args.bus, args.address, offset_c=None, altitude_m=None,
        co2_min=args.co2_min, co2_max=args.co2_max,
    )
    print(f"opening i2c-{args.bus} @ 0x{args.address:02x} ...")
    sensor.start()
    print(f"  {sensor.describe()}")

    if not args.skip_self_test:
        print("self-test (about 10 s) ...")
        # Only meaningful with measurement stopped, which start() has done and
        # the sample loop below has not yet undone.
        sensor._send(0x3F86, exec_ms=500, tolerate=True)
        result = sensor.self_test()
        print(f"  result 0x{result:04x} -> {'PASS' if result == 0 else 'FAIL'}")
        if result != 0:
            print("  A non-zero self-test is the chip reporting its own fault.")
        sensor._send(0x21B1)

    print(f"sampling {args.samples} times, 10 s apart ...")
    good = bad = none = 0
    worst: list[str] = []
    for i in range(args.samples):
        time.sleep(10)
        try:
            reading = sensor.read()
        except OSError as err:
            # A CRC failure is a BUS problem - wiring, connector, length -
            # not the same fault as a chip returning garbage that checksums.
            print(f"  [{i:>3}] I2C ERROR: {err}")
            bad += 1
            continue
        if reading is None:
            none += 1
            continue
        c = reading.co2_ppm
        if c.valid:
            good += 1
        else:
            bad += 1
            if len(worst) < 8:
                worst.append(f"{c.reason}")
        print(
            f"  [{i:>3}] co2={c.value if c.valid else 'REFUSED':>8} "
            f"t={reading.temperature_c.value:>6} rh={reading.humidity_pct.value:>5}"
            f"{'' if c.valid else '   <- ' + str(c.reason)}"
        )

    total = good + bad
    print()
    print(f"  usable   {good}/{total}" + (f"  ({100 * good // total}%)" if total else ""))
    print(f"  refused  {bad}")
    print(f"  not-ready{none:>4}  (normal: the chip answers every 5 s)")
    for w in worst:
        print(f"    {w}")
    sensor.stop()
    return 0 if total and good == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
