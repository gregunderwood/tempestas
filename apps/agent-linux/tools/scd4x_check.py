#!/usr/bin/env python3
"""Is this SCD4x healthy? Runs the chip's self-test, then samples so intermittent faults show."""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import dataclass, field
from functools import partial

sys.path.insert(0, str(__file__.rsplit("/tools/", 1)[0] + "/src"))

from tempestas_agent.runtime import is_agent_service_active  # noqa: E402
from tempestas_agent.sensor import Scd4xSensor  # noqa: E402

SAMPLE_SPACING_S = 10
SELF_TEST_PASS = 0x0000
MAX_REASONS_SHOWN = 8
EXIT_HEALTHY = 0
EXIT_UNHEALTHY = 1
EXIT_AGENT_RUNNING = 2


@dataclass
class Tally:
    usable: int = 0
    refused: int = 0
    not_ready: int = 0
    reasons: list[str] = field(default_factory=list)

    @property
    def answered(self) -> int:
        return self.usable + self.refused


def main() -> int:
    arguments = parse_arguments()
    if is_agent_service_active() and not arguments.force:
        print("tempestas-agent is running, or systemd could not say. It owns the sensor,")
        print("and two readers interleave into nonsense. Stop it first:")
        print("  sudo systemctl stop tempestas-agent")
        print("If systemctl cannot answer, check by hand and rerun with --force.")
        return EXIT_AGENT_RUNNING

    sensor = Scd4xSensor(
        arguments.bus,
        arguments.address,
        offset_c=None,
        altitude_m=None,
        co2_min_ppm=arguments.co2_min,
        co2_max_ppm=arguments.co2_max,
    )
    print(f"opening i2c-{arguments.bus} @ 0x{arguments.address:02x} ...")
    sensor.start()
    print(f"  {sensor.describe()}")

    if not arguments.skip_self_test:
        run_self_test(sensor)

    tally = sample(sensor, arguments.samples)
    print_summary(tally)
    sensor.stop()
    return EXIT_HEALTHY if tally.answered and tally.usable == tally.answered else EXIT_UNHEALTHY


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="scd4x_check")
    parser.add_argument("--bus", type=int, default=1)
    parser.add_argument("--address", type=partial(int, base=0), default=0x62)
    parser.add_argument("--samples", type=int, default=30, help="10 s apart")
    parser.add_argument("--co2-min", type=int, default=400)
    parser.add_argument("--co2-max", type=int, default=5000)
    parser.add_argument("--skip-self-test", action="store_true")
    parser.add_argument("--force", action="store_true", help="run even if the agent is up")
    return parser.parse_args()


def run_self_test(sensor: Scd4xSensor) -> None:
    print("self-test (about 10 s) ...")
    sensor.stop_periodic_measurement()
    result = sensor.self_test()
    print(f"  result 0x{result:04x} -> {'PASS' if result == SELF_TEST_PASS else 'FAIL'}")
    if result != SELF_TEST_PASS:
        print("  A non-zero self-test is the chip reporting its own fault.")
    sensor.start_periodic_measurement()


def sample(sensor: Scd4xSensor, count: int) -> Tally:
    print(f"sampling {count} times, 10 s apart ...")
    tally = Tally()
    for sample_index in range(count):
        time.sleep(SAMPLE_SPACING_S)
        try:
            reading = sensor.read()
        except OSError as error:
            # A CRC failure is a bus problem (wiring, connector, length), not a chip fault.
            print(f"  [{sample_index:>3}] I2C ERROR: {error}")
            tally.refused += 1
            continue
        if reading is None:
            tally.not_ready += 1
            continue
        record(tally, reading.co2_ppm)
        print_reading(sample_index, reading)
    return tally


def record(tally: Tally, co2) -> None:
    if co2.valid:
        tally.usable += 1
        return
    tally.refused += 1
    if len(tally.reasons) < MAX_REASONS_SHOWN:
        tally.reasons.append(f"{co2.reason}")


def print_reading(sample_index: int, reading) -> None:
    co2 = reading.co2_ppm
    print(
        f"  [{sample_index:>3}] co2={co2.value if co2.valid else 'REFUSED':>8} "
        f"t={reading.temperature_c.value:>6} rh={reading.humidity_pct.value:>5}"
        f"{'' if co2.valid else '   <- ' + str(co2.reason)}"
    )


def print_summary(tally: Tally) -> None:
    usable_share = f"  ({100 * tally.usable // tally.answered}%)" if tally.answered else ""
    print()
    print(f"  usable   {tally.usable}/{tally.answered}" + usable_share)
    print(f"  refused  {tally.refused}")
    print(f"  not-ready{tally.not_ready:>4}  (normal: the chip answers every 5 s)")
    for reason in tally.reasons:
        print(f"    {reason}")


if __name__ == "__main__":
    raise SystemExit(main())
