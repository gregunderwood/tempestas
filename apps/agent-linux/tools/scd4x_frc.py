#!/usr/bin/env python3
"""Forced recalibration; see "Forced recalibration" in docs/Infrastructure/Linux Agent.md first."""

from __future__ import annotations

import argparse
import sys
import time
from functools import partial

sys.path.insert(0, str(__file__.rsplit("/tools/", 1)[0] + "/src"))

from tempestas_agent.runtime import is_agent_service_active  # noqa: E402
from tempestas_agent.sensor import Scd4xSensor  # noqa: E402

SETTLE_S = 240  # the datasheet wants 3+ minutes of periodic measurement; take 4
SAMPLE_SPACING_S = 10
PLAUSIBLE_TARGET_PPM = (300, 2000)
STABILITY_WINDOW = 6
MAX_SPREAD_PPM = 40
MAX_DRIFT_PPM_PER_MIN = 0.5
SUSPICIOUS_CORRECTION_PPM = 250
SECONDS_PER_MINUTE = 60.0
EXIT_OK = 0
EXIT_UNSTABLE = 1
EXIT_REFUSED = 2


def main() -> int:
    arguments = parse_arguments()
    lowest_target, highest_target = PLAUSIBLE_TARGET_PPM
    if not lowest_target <= arguments.target <= highest_target:
        print(f"--target {arguments.target} is not a plausible reference. Outdoor air is ~425.")
        return EXIT_REFUSED
    if is_agent_service_active() and not arguments.force:
        print("tempestas-agent is running, or systemd could not say. It owns the sensor.")
        print("Stop it first:")
        print("  sudo systemctl stop tempestas-agent")
        print("If systemctl cannot answer, check by hand and rerun with --force.")
        return EXIT_REFUSED

    sensor = Scd4xSensor(arguments.bus, arguments.address, offset_c=None, altitude_m=None)
    sensor.start()
    print(f"  {sensor.describe()}")

    readings = collect_settling_readings(sensor, arguments.settle)
    if not is_reference_stable(readings, arguments.settle):
        return EXIT_UNSTABLE

    apply_recalibration(sensor, arguments.target)
    persist_or_warn(sensor, arguments.persist)
    report_reading_after(sensor, arguments.target)
    sensor.stop()
    return EXIT_OK


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="scd4x_frc")
    parser.add_argument("--target", type=int, required=True, help="known ppm of the air it is in")
    parser.add_argument("--bus", type=int, default=1)
    parser.add_argument("--address", type=partial(int, base=0), default=0x62)
    parser.add_argument("--settle", type=int, default=SETTLE_S)
    parser.add_argument("--persist", action="store_true", help="survive a power cycle")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def collect_settling_readings(sensor: Scd4xSensor, settle_s: int) -> list[float]:
    print(f"settling for {settle_s}s of periodic measurement ...")
    readings: list[float] = []
    deadline = time.time() + settle_s
    while time.time() < deadline:
        time.sleep(SAMPLE_SPACING_S)
        reading = sensor.read()
        if reading is not None and reading.co2_ppm.valid:
            readings.append(reading.co2_ppm.value)
            print(f"    {reading.co2_ppm.value:>6.0f} ppm   {reading.temperature_c.value:>5}C")
    return readings


def is_reference_stable(readings: list[float], settle_s: int) -> bool:
    if len(readings) < STABILITY_WINDOW:
        print(f"only {len(readings)} usable readings - too unstable to calibrate against.")
        print("Fix the sensor before calibrating it.")
        return False

    recent = readings[-STABILITY_WINDOW:]
    spread = max(recent) - min(recent)
    mean = sum(recent) / len(recent)
    print(f"  last {STABILITY_WINDOW}: mean {mean:.0f} ppm, spread {spread:.0f} ppm")
    if spread > MAX_SPREAD_PPM:
        print(f"  spread {spread:.0f} ppm is too wide - the air has not settled. Wait longer.")
        return False

    # Spread alone is not enough: air still on its way somewhere is not a reference.
    drift_per_min = (readings[-1] - readings[0]) / (settle_s / SECONDS_PER_MINUTE)
    print(f"  trend: {drift_per_min:+.1f} ppm/min across the settle")
    if abs(drift_per_min) > MAX_DRIFT_PPM_PER_MIN:
        print("  The air is still MOVING. Calibrating now bakes in wherever it")
        print("  happened to be, not where it is going. Ventilate and wait for")
        print("  it to flatten, then re-run.")
        return False
    return True


def apply_recalibration(sensor: Scd4xSensor, target_ppm: int) -> None:
    print(f"applying forced recalibration to {target_ppm} ppm ...")
    correction = sensor.forced_recalibration(target_ppm)
    print(f"  correction applied: {correction:+d} ppm")
    # The chip reports the adjustment it made, so its sign is opposite to the error it carried.
    direction = "high" if correction < 0 else "low"
    print(f"  (it had been reading {direction} by {abs(correction)} ppm)")
    if abs(correction) > SUSPICIOUS_CORRECTION_PPM:
        print("  A correction this large is a reason to DISTRUST the sensor, not to")
        print("  trust the calibration. Check the reference was right.")


def persist_or_warn(sensor: Scd4xSensor, should_persist: bool) -> None:
    if should_persist:
        sensor.persist_settings()
        print("  persisted to EEPROM (survives a power cycle)")
        return
    print("  NOT persisted - it will be lost on power loss. Re-run with --persist")
    print("  once you are satisfied the result is right.")


def report_reading_after(sensor: Scd4xSensor, target_ppm: int) -> None:
    time.sleep(SAMPLE_SPACING_S)
    after = sensor.read()
    if after is not None and after.co2_ppm.valid:
        print(f"  reading now: {after.co2_ppm.value:.0f} ppm (target was {target_ppm})")


if __name__ == "__main__":
    raise SystemExit(main())
