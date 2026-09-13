#!/usr/bin/env python3
"""Forced recalibration: tell the sensor what it should be reading.

    sudo systemctl stop tempestas-agent
    uv run python tools/scd4x_frc.py --target 425
    sudo systemctl start tempestas-agent

WHEN to use this: the sensor's baseline has gone wrong and you can put it in
air of known concentration. On elantris, a failing sensor emitted spurious
readings near 300 ppm; ASC took the lowest of those for fresh air at 400 and
biased everything about 115 ppm high. Disabling ASC stopped the drift but froze
the error - only an FRC undoes it.

WHEN NOT to: if you cannot say what the air actually is. A wrong reference does
not fail, it just moves the error, and the result looks exactly as authoritative
as a good one. Guessing here is worse than the drift.

Getting the reference right
---------------------------
Outdoor air is about 420-430 ppm and rising a couple of ppm a year. A greenhouse
approaches it only with the door open and enough time to mix - and a crop in
daylight pulls it BELOW outdoor, while a closed house at night sits well above.
So ventilate, wait, and prefer a moment when nothing is being enriched.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

sys.path.insert(0, str(__file__.rsplit("/tools/", 1)[0] + "/src"))

from tempestas_agent.sensor import Scd4xSensor  # noqa: E402

SETTLE_S = 240  # datasheet wants 3+ minutes of periodic measurement; take 4


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
    p = argparse.ArgumentParser(prog="scd4x_frc")
    p.add_argument("--target", type=int, required=True, help="known ppm of the air it is in")
    p.add_argument("--bus", type=int, default=1)
    p.add_argument("--address", type=lambda s: int(s, 0), default=0x62)
    p.add_argument("--settle", type=int, default=SETTLE_S)
    p.add_argument("--persist", action="store_true", help="survive a power cycle")
    p.add_argument("--force", action="store_true")
    args = p.parse_args()

    if not 300 <= args.target <= 2000:
        print(f"--target {args.target} is not a plausible reference. Outdoor air is ~425.")
        return 2
    if agent_is_running() and not args.force:
        print("tempestas-agent is ACTIVE and owns the sensor. Stop it first:")
        print("  sudo systemctl stop tempestas-agent")
        return 2

    sensor = Scd4xSensor(args.bus, args.address, offset_c=None, altitude_m=None)
    sensor.start()
    print(f"  {sensor.describe()}")

    print(f"settling for {args.settle}s of periodic measurement ...")
    readings: list[float] = []
    deadline = time.time() + args.settle
    while time.time() < deadline:
        time.sleep(10)
        r = sensor.read()
        if r and r.co2_ppm.valid:
            readings.append(r.co2_ppm.value)
            print(f"    {r.co2_ppm.value:>6.0f} ppm   {r.temperature_c.value:>5}C")

    if len(readings) < 6:
        print(f"only {len(readings)} usable readings - too unstable to calibrate against.")
        print("Fix the sensor before calibrating it.")
        return 1

    # A drifting reading means the air is still changing, and calibrating
    # against a moving reference just bakes in whatever it happened to be.
    recent = readings[-6:]
    spread = max(recent) - min(recent)
    mean = sum(recent) / len(recent)
    print(f"  last 6: mean {mean:.0f} ppm, spread {spread:.0f} ppm")
    if spread > 40:
        print(f"  spread {spread:.0f} ppm is too wide - the air has not settled. Wait longer.")
        return 1

    print(f"applying forced recalibration to {args.target} ppm ...")
    correction = sensor.forced_recalibration(args.target)
    print(f"  correction applied: {correction:+d} ppm")
    print(f"  (it was reading {'high' if correction > 0 else 'low'} by {abs(correction)})")
    if abs(correction) > 250:
        print("  A correction this large is a reason to DISTRUST the sensor, not to")
        print("  trust the calibration. Check the reference was right.")

    if args.persist:
        sensor.persist_settings()
        print("  persisted to EEPROM (survives a power cycle)")
    else:
        print("  NOT persisted - it will be lost on power loss. Re-run with --persist")
        print("  once you are satisfied the result is right.")

    time.sleep(10)
    after = sensor.read()
    if after and after.co2_ppm.valid:
        print(f"  reading now: {after.co2_ppm.value:.0f} ppm (target was {args.target})")
    sensor.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
