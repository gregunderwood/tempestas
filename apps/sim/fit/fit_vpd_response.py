#!/usr/bin/env python3
"""Find the leaf VPD at which this greenhouse takes up the most CO2; method in README.md.

    uv run python fit/fit_vpd_response.py readings.json \
        --transitions transitions.json --lights 07:00-19:00
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta, timezone

LOCAL = timezone(timedelta(hours=-7))

# The canopy sensor bottoms out near 440 on a ventilated afternoon; the fits tolerate +/-20.
OUTDOOR_PPM = 420.0

MIN_MINUTE_BUCKETS = 8
MIN_PAIRWISE_SLOPES = 8
MIN_PAIR_SPAN_MINUTES = 2.0
PAIR_SPAN_FRACTION_OF_WINDOW = 4.0
NORMAL_MAD_TO_STANDARD_DEVIATION = 1.4826
OUTLIER_STANDARD_DEVIATIONS = 3.5
MIN_INLIERS = 3
MIN_SAMPLES_PER_WINDOW = 20

MIN_DARK_WINDOWS = 6
MIN_SEPARABLE_SPREAD_PPM = 150
MIN_CALIBRATION_R_SQUARED = 0.25
VENTILATED_BELOW_OUTDOOR_PPM = 40
VENTILATED_ABOVE_OUTDOOR_PPM = 150
VPD_BINS_PER_KPA = 4

MAGNUS_COEFFICIENT_KPA = 0.6112
MAGNUS_TEMPERATURE_FACTOR = 17.62
MAGNUS_TEMPERATURE_OFFSET_C = 243.12


def saturation_pressure_kpa(temp_c: float) -> float:
    """Saturation vapour pressure in kPa, by the Magnus form the docs use."""
    return MAGNUS_COEFFICIENT_KPA * math.exp(
        (MAGNUS_TEMPERATURE_FACTOR * temp_c) / (MAGNUS_TEMPERATURE_OFFSET_C + temp_c)
    )


def vpd_kpa(temp_c: float, rh_pct: float, leaf_offset_c: float) -> float:
    """Leaf VPD: the leaf interior is saturated at leaf temperature, not air temperature."""
    return saturation_pressure_kpa(temp_c + leaf_offset_c) - (
        rh_pct / 100.0
    ) * saturation_pressure_kpa(temp_c)


@dataclass(frozen=True)
class Sample:
    at: datetime
    temp_c: float
    rh_pct: float
    co2_ppm: float


@dataclass(frozen=True)
class Window:
    start: datetime
    minutes: float
    co2_mid: float
    co2_slope_ppm_per_minute: float
    vpd: float
    temp_c: float
    sample_count: int


@dataclass(frozen=True)
class RobustLine:
    intercept: float
    slope: float
    r_squared: float
    outlier_indices: list[int]


def pairwise_slopes(
    points: list[tuple[float, float]], is_far_enough: Callable[[float], bool]
) -> list[float]:
    return [
        (later[1] - earlier[1]) / (later[0] - earlier[0])
        for index, earlier in enumerate(points)
        for later in points[index + 1 :]
        if is_far_enough(later[0] - earlier[0])
    ]


def robust_slope(samples: list[Sample]) -> float | None:
    """Theil-Sen slope in ppm/min over minute-medians; why both, see README.md."""
    buckets: dict[int, list[float]] = {}
    first_at = samples[0].at
    for sample in samples:
        minute = int((sample.at - first_at).total_seconds() // 60)
        buckets.setdefault(minute, []).append(sample.co2_ppm)
    minute_medians = sorted(
        (minute, statistics.median(values)) for minute, values in buckets.items()
    )
    if len(minute_medians) < MIN_MINUTE_BUCKETS:
        return None

    window_span = minute_medians[-1][0] - minute_medians[0][0]
    min_gap = max(MIN_PAIR_SPAN_MINUTES, window_span / PAIR_SPAN_FRACTION_OF_WINDOW)
    slopes = pairwise_slopes(minute_medians, lambda gap: gap >= min_gap)
    return statistics.median(slopes) if len(slopes) >= MIN_PAIRWISE_SLOPES else None


def fit_line_robust(points: list[tuple[float, float]]) -> RobustLine:
    """Theil-Sen over (CO2, dC/dt); least squares sign-inverts on one bad window."""
    slopes = pairwise_slopes(points, lambda gap: gap != 0)
    if not slopes:
        return RobustLine(0.0, 0.0, 0.0, [])
    slope = statistics.median(slopes)
    intercept = statistics.median(rate - slope * co2 for co2, rate in points)

    residuals = [rate - (intercept + slope * co2) for co2, rate in points]
    median_absolute_deviation = statistics.median(abs(residual) for residual in residuals)
    limit = (
        OUTLIER_STANDARD_DEVIATIONS * NORMAL_MAD_TO_STANDARD_DEVIATION * median_absolute_deviation
        if median_absolute_deviation > 0
        else float("inf")
    )
    outliers = [index for index, residual in enumerate(residuals) if abs(residual) > limit]

    inliers = [point for index, point in enumerate(points) if index not in set(outliers)]
    if len(inliers) < MIN_INLIERS:
        return RobustLine(intercept, slope, 0.0, outliers)
    mean = statistics.fmean(rate for _, rate in inliers)
    total_sum_of_squares = sum((rate - mean) ** 2 for _, rate in inliers)
    residual_sum_of_squares = sum((rate - (intercept + slope * co2)) ** 2 for co2, rate in inliers)
    r_squared = 1 - residual_sum_of_squares / total_sum_of_squares if total_sum_of_squares else 0.0
    return RobustLine(intercept, slope, r_squared, outliers)


def parse_utc(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def is_complete_reading(reading: dict) -> bool:
    return all(reading.get(key) is not None for key in ("co2", "temperature", "humidity"))


def load_samples(path: str) -> list[Sample]:
    with open(path) as readings_file:
        readings = json.load(readings_file)
    samples = [
        Sample(
            at=parse_utc(reading["createdAt"]),
            temp_c=float(reading["temperature"]),
            rh_pct=float(reading["humidity"]),
            co2_ppm=float(reading["co2"]),
        )
        for reading in readings
        if is_complete_reading(reading)
    ]
    samples.sort(key=lambda sample: sample.at)
    return samples


def burner_spans(path: str | None, pin: int) -> list[tuple[datetime, datetime]]:
    """When the burner was energised, by `energised` since the ON level is per device."""
    if not path:
        return []
    with open(path) as transitions_file:
        transitions = json.load(transitions_file)
    events = sorted(
        (parse_utc(transition["observedAt"]), transition["energised"])
        for transition in transitions
        if transition["pin"] == pin and transition["energised"] is not None
    )
    spans, opened = [], None
    for at, is_energised in events:
        if is_energised and opened is None:
            opened = at
        elif not is_energised and opened is not None:
            spans.append((opened, at))
            opened = None
    if opened is not None:
        spans.append((opened, datetime.now(UTC)))
    return spans


def burner_quiet(at: datetime, spans, settle_min: float) -> bool:
    """Off, and long enough ago that CO2 still in transit has arrived."""
    settle = timedelta(minutes=settle_min)
    return all(not (start <= at <= end + settle) for start, end in spans)


def is_lit(at: datetime, lights: tuple[time, time] | None) -> bool:
    local = at.astimezone(LOCAL).time()
    return lights is not None and lights[0] <= local < lights[1]


def summarise_window(
    start: datetime, chunk: list[Sample], minutes: float, rate: float, leaf_offset: float
) -> Window:
    return Window(
        start=start,
        minutes=minutes,
        co2_mid=statistics.median([sample.co2_ppm for sample in chunk]),
        co2_slope_ppm_per_minute=rate,
        vpd=statistics.median(
            [vpd_kpa(sample.temp_c, sample.rh_pct, leaf_offset) for sample in chunk]
        ),
        temp_c=statistics.median([sample.temp_c for sample in chunk]),
        sample_count=len(chunk),
    )


def collect_windows(
    samples: list[Sample],
    spans,
    *,
    minutes: float,
    lights: tuple[time, time] | None,
    dark: bool,
    leaf_offset: float,
    settle_min: float,
) -> list[Window]:
    collected: list[Window] = []
    span = timedelta(minutes=minutes)
    index = 0
    while index < len(samples):
        start = samples[index].at
        chunk = [sample for sample in samples if start <= sample.at < start + span]
        if len(chunk) < MIN_SAMPLES_PER_WINDOW:
            index += 1
            continue
        index += len(chunk)
        is_wrong_half_of_day = dark == is_lit(start, lights)
        if is_wrong_half_of_day:
            continue
        if not all(burner_quiet(sample.at, spans, settle_min) for sample in chunk):
            continue
        rate = robust_slope(chunk)
        if rate is None:
            continue
        collected.append(summarise_window(start, chunk, minutes, rate, leaf_offset))
    return collected


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="fit_vpd_response")
    parser.add_argument("readings", help="tempestas readings JSON")
    parser.add_argument("--transitions", help="pin_transitions JSON (burner state)")
    parser.add_argument("--pin", type=int, default=5, help="burner GPIO pin")
    parser.add_argument("--lights", default="07:00-19:00", help="HH:MM-HH:MM local")
    parser.add_argument("--window", type=float, default=15.0, help="minutes per measurement window")
    parser.add_argument(
        "--after",
        help="ignore measurement windows before this local time, e.g. '2026-09-24 07:00'",
    )
    parser.add_argument("--before", help="ignore measurement windows after this local time")
    parser.add_argument(
        "--calib-window",
        type=float,
        default=60.0,
        help="minutes per night-calibration window; long by default "
        "because overnight drift is slow and needs the baseline",
    )
    parser.add_argument(
        "--leaf-offset",
        type=float,
        default=1.0,
        help="leaf minus air, C. ~1 with strong airflow, ~2 still",
    )
    parser.add_argument(
        "--settle", type=float, default=8.0, help="minutes to ignore after the burner stops"
    )
    parser.add_argument(
        "--leak-k", type=float, help="known leak coefficient /min, skipping night calibration"
    )
    return parser.parse_args()


def parse_lights(text: str) -> tuple[time, time]:
    lights_on, lights_off = text.split("-")
    return (time.fromisoformat(lights_on), time.fromisoformat(lights_off))


def print_not_separable(night: list[Window], spread: float) -> None:
    equilibrium_ppm = statistics.median([window.co2_mid for window in night])
    print()
    print(
        f"  NOT SEPARABLE: CO2 only moved {spread:.0f} ppm and sat near {equilibrium_ppm:.0f} ppm."
    )
    print("  At equilibrium respiration exactly balances leakage, so dC/dt is ~0")
    print("  at every concentration and there is no slope to fit. All such a")
    print(
        f"  night tells you is the ratio  R = k x ({equilibrium_ppm:.0f} - {OUTDOOR_PPM:.0f})"
        f" = {equilibrium_ppm - OUTDOOR_PPM:.0f} k"
    )
    print()
    print("  Either the sensor is flat-lining (check it), or this really was a")
    print("  settled night - in which case perturb it: run the burner at night")
    print("  to ~1200 ppm and let it decay in the dark, where dC/dt varies with")
    print("  C and both constants fall out of one regression.")
    print()
    print("  Once you have it:  --leak-k <value>")


def print_poor_fit(r_squared: float, calibration_window_minutes: float) -> None:
    print()
    print(f"  POOR FIT (R2 = {r_squared:.2f}): CO2 moved, but not in a way the leak model")
    print("  explains. Usual causes: a vent or door opened during the night, the")
    print("  burner ran without being logged, or the window is too short for the")
    print(f"  drift ({calibration_window_minutes:.0f} min - try --calib-window 90).")


def calibrate_leak(
    samples: list[Sample], spans, lights: tuple[time, time], arguments: argparse.Namespace
) -> float | None:
    """Stage 1: leak coefficient and respiration from dark, burner-off windows."""
    night = collect_windows(
        samples,
        spans,
        minutes=arguments.calib_window,
        lights=lights,
        dark=True,
        leaf_offset=arguments.leaf_offset,
        settle_min=arguments.settle,
    )
    print(f"\nCALIBRATION - {len(night)} dark windows")
    if len(night) < MIN_DARK_WINDOWS:
        print("  too few to fit. Need a night with the burner off and CO2 moving.")
        return None
    points = [(window.co2_mid, window.co2_slope_ppm_per_minute) for window in night]
    spread = max(point[0] for point in points) - min(point[0] for point in points)
    line = fit_line_robust(points)
    leak = -line.slope
    print(f"  CO2 spanned {spread:.0f} ppm across the dark windows")
    print(
        f"  dC/dt = {line.intercept:+.3f} {line.slope:+.5f} * C      R2 = {line.r_squared:.3f}"
        f"  ({len(points) - len(line.outlier_indices)}/{len(points)} windows)"
    )
    for index in line.outlier_indices:
        window = night[index]
        print(
            f"    rejected {window.start.astimezone(LOCAL):%m-%d %H:%M}  "
            f"C={window.co2_mid:.0f} dC/dt={window.co2_slope_ppm_per_minute:+.2f}"
            " - something happened here"
        )

    if arguments.leak_k is not None:
        leak = arguments.leak_k
        print(f"  overridden: k = {leak:.5f} /min (--leak-k)")
    elif spread < MIN_SEPARABLE_SPREAD_PPM:
        print_not_separable(night, spread)
        return None
    elif leak <= 0 or line.r_squared < MIN_CALIBRATION_R_SQUARED:
        print_poor_fit(line.r_squared, arguments.calib_window)
        return None
    print(f"  leak coefficient k ......... {leak:.5f} /min")
    print(f"  (C_out + R/k) .............. {line.intercept / leak:.0f} ppm")
    print(f"  With outdoor air near {OUTDOOR_PPM:.0f} ppm, the excess is respiration:")
    respiration = line.intercept - leak * OUTDOOR_PPM
    print(f"  respiration R .............. {respiration:+.2f} ppm/min")
    return leak


def parse_local_bound(text: str | None) -> datetime | None:
    return datetime.fromisoformat(text).replace(tzinfo=LOCAL) if text else None


def keep_between(windows: list[Window], after: str | None, before: str | None) -> list[Window]:
    """Measurement only: calibration still wants the whole night around the run."""
    earliest = parse_local_bound(after)
    latest = parse_local_bound(before)
    return [
        window
        for window in windows
        if (earliest is None or window.start >= earliest)
        and (latest is None or window.start <= latest)
    ]


def is_ventilated(lit_co2_ppm: float) -> bool:
    """A lit, planted house pinned near outdoor air is exchanging it; a sealed one draws below."""
    return (
        OUTDOOR_PPM - VENTILATED_BELOW_OUTDOOR_PPM
        <= lit_co2_ppm
        <= OUTDOOR_PPM + VENTILATED_ABOVE_OUTDOOR_PPM
    )


def print_refusal_for_open_house(lit_co2_ppm: float, leak: float) -> None:
    print(f"  median CO2 across those windows: {lit_co2_ppm:.0f} ppm")
    print()
    print("  REFUSING TO FIT - the greenhouse was open.")
    print(f"  Lit, planted, and still sitting near outdoor air ({OUTDOOR_PPM:.0f} ppm)")
    print("  means air was being exchanged far faster than the sealed-night")
    print(f"  k of {leak:.5f}/min. The leak term would understate removal by an")
    print("  order of magnitude and every assimilation figure would be noise.")
    print()
    print("  Assimilation is only measurable on a closed house: vents shut,")
    print("  exhaust fans off, CO2 drawn down from an enriched start. That is")
    print("  the same sealed run being planned for the humidity question, so")
    print("  capture this from it - a couple of lit hours sealed, with the")
    print("  burner left off once the house is charged, is enough.")


def print_uptake_table(day: list[Window], leak: float) -> list[tuple[Window, float]]:
    print(f"  {'when':>11} {'VPD':>6} {'temp':>6} {'CO2':>6} {'dC/dt':>8} {'net':>8}")
    uptakes = []
    for window in day:
        # Net uptake (A - R): respiration in the light is not the night figure, so it stays out.
        net_uptake = leak * (OUTDOOR_PPM - window.co2_mid) - window.co2_slope_ppm_per_minute
        uptakes.append((window, net_uptake))
        print(
            f"  {window.start.astimezone(LOCAL):%m-%d %H:%M} {window.vpd:>6.2f} "
            f"{window.temp_c:>5.1f}C {window.co2_mid:>6.0f} "
            f"{window.co2_slope_ppm_per_minute:>+8.1f} {net_uptake:>+8.1f}"
        )
    return uptakes


def print_uptake_curve(uptakes: list[tuple[Window, float]]) -> None:
    print("\nNET CO2 UPTAKE vs VPD  (ppm/min, higher is better)")
    bins: dict[float, list[float]] = {}
    for window, net_uptake in uptakes:
        bins.setdefault(round(window.vpd * VPD_BINS_PER_KPA) / VPD_BINS_PER_KPA, []).append(
            net_uptake
        )
    for vpd in sorted(bins):
        bin_uptakes = bins[vpd]
        median_uptake = statistics.median(bin_uptakes)
        bar = "#" * max(0, int(median_uptake))
        print(f"  {vpd:>5.2f} kPa  n={len(bin_uptakes):<3} median {median_uptake:>+7.1f}  {bar}")
    best = max(bins, key=lambda vpd: statistics.median(bins[vpd]))
    print(f"\n  best bin: {best:.2f} kPa")
    print("  Treat one day's curve as provisional - light, temperature and CO2")
    print("  itself all move with VPD across a drawdown. Compare windows at")
    print("  matched hour, temperature and CO2 across several days before")
    print("  believing a peak.")


def measure_uptake(
    samples: list[Sample],
    spans,
    lights: tuple[time, time],
    leak: float,
    arguments: argparse.Namespace,
) -> int:
    """Stage 2: net uptake under light with the burner quiet, binned by VPD."""
    day = collect_windows(
        samples,
        spans,
        minutes=arguments.window,
        lights=lights,
        dark=False,
        leaf_offset=arguments.leaf_offset,
        settle_min=arguments.settle,
    )
    if arguments.after or arguments.before:
        day = keep_between(day, arguments.after, arguments.before)

    print(f"\nMEASUREMENT - {len(day)} lit windows with the burner quiet")
    lit_co2_ppm = statistics.median([window.co2_mid for window in day]) if day else 0.0
    if day and is_ventilated(lit_co2_ppm):
        print_refusal_for_open_house(lit_co2_ppm, leak)
        return 1
    if not day:
        print("  none. The burner may be running through the whole photoperiod.")
        return 1
    print_uptake_curve(print_uptake_table(day, leak))
    return 0


def main() -> int:
    arguments = parse_arguments()
    lights = parse_lights(arguments.lights)

    samples = load_samples(arguments.readings)
    if not samples:
        print("no usable readings")
        return 1
    spans = burner_spans(arguments.transitions, arguments.pin)
    print(
        f"{len(samples)} readings  {samples[0].at.astimezone(LOCAL):%m-%d %H:%M}"
        f" -> {samples[-1].at.astimezone(LOCAL):%m-%d %H:%M}"
    )
    print(f"{len(spans)} burner spans; lights {arguments.lights}")

    leak = calibrate_leak(samples, spans, lights, arguments)
    if leak is None:
        return 1
    return measure_uptake(samples, spans, lights, leak, arguments)


if __name__ == "__main__":
    raise SystemExit(main())
