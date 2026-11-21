#!/usr/bin/env python3
"""Fit the greenhouse envelope (leak and outdoor baseline) from the 2025 season; see README.md.

uv run python fit/fit_envelope.py <greenhouse-readings.csv.gz>
"""

from __future__ import annotations

import gzip
import sys
from datetime import datetime
from typing import NamedTuple

from least_squares import Line, fit_least_squares_line

# After 2025-11-01 enrichment stops and the trace is flat at the winter baseline.
WINDOW_START = datetime(2025, 8, 23)
WINDOW_END = datetime(2025, 11, 2)

SMOOTH_SAMPLES = 6
DERIVATIVE_SAMPLES = 6
LAG_DRAIN_MINUTES = 5.0
FALLING_PPM_PER_MINUTE = -1.0
MIN_CONTIGUOUS_SPAN_MINUTES = 0.5
MAX_CONTIGUOUS_SPAN_MINUTES = 2.0
# Below this the fall is photosynthetic draw-down, a different process that wrecks the pooled fit.
MIN_ENRICHED_PPM = 900.0

IMPLAUSIBLY_HIGH_PPM = 5000
IMPLAUSIBLY_LOW_PPM = 300
MIN_DECAY_POINTS = 100
MIN_POINTS_PER_MONTH = 50
SETPOINTS_PPM = (1200.0, 1500.0, 1600.0)


class DecayPoint(NamedTuple):
    co2_ppm: float
    slope_ppm_per_minute: float
    observed_at: datetime


def is_plausible_co2(co2_ppm: float) -> bool:
    return IMPLAUSIBLY_LOW_PPM <= co2_ppm <= IMPLAUSIBLY_HIGH_PPM


def is_in_window(observed_at: datetime) -> bool:
    return WINDOW_START <= observed_at.replace(tzinfo=None) < WINDOW_END


def load(path: str) -> list[tuple[datetime, float]]:
    rows: list[tuple[datetime, float]] = []
    with gzip.open(path, "rt") as csv_file:
        next(csv_file)
        for line in csv_file:
            timestamp_text, _temp, _humidity, co2_text = line.rstrip("\n").split(",")
            if not co2_text:
                continue
            co2_ppm = float(co2_text)
            if not is_plausible_co2(co2_ppm):
                continue
            observed_at = datetime.fromisoformat(timestamp_text)
            if not is_in_window(observed_at):
                continue
            rows.append((observed_at, co2_ppm))
    rows.sort(key=lambda row: row[0])
    return rows


def smooth(values: list[float], width: int) -> list[float]:
    smoothed, running_total = [], 0.0
    for index, value in enumerate(values):
        running_total += value
        if index >= width:
            running_total -= values[index - width]
        smoothed.append(running_total / min(index + 1, width))
    return smoothed


def is_contiguous(span_minutes: float) -> bool:
    return MIN_CONTIGUOUS_SPAN_MINUTES <= span_minutes <= MAX_CONTIGUOUS_SPAN_MINUTES


def collect_decay_points(rows: list[tuple[datetime, float]]) -> list[DecayPoint]:
    """Falling, enriched samples once the transport lag has drained."""
    times = [row[0] for row in rows]
    co2 = smooth([row[1] for row in rows], SMOOTH_SAMPLES)
    points: list[DecayPoint] = []
    falling_for_minutes = 0.0
    for index in range(DERIVATIVE_SAMPLES, len(rows)):
        earlier = index - DERIVATIVE_SAMPLES
        span_minutes = (times[index] - times[earlier]).total_seconds() / 60.0
        if not is_contiguous(span_minutes):
            falling_for_minutes = 0.0
            continue
        slope = (co2[index] - co2[earlier]) / span_minutes

        if slope > FALLING_PPM_PER_MINUTE:
            falling_for_minutes = 0.0
            continue
        falling_for_minutes += span_minutes / DERIVATIVE_SAMPLES

        if falling_for_minutes < LAG_DRAIN_MINUTES:
            continue
        if co2[index] < MIN_ENRICHED_PPM:
            continue
        points.append(DecayPoint(co2[index], slope, times[index]))
    return points


def to_xy(points: list[DecayPoint]) -> list[tuple[float, float]]:
    return [(point.co2_ppm, point.slope_ppm_per_minute) for point in points]


def residual_sum_of_squares(points: list[DecayPoint], line: Line) -> float:
    return sum((point.slope_ppm_per_minute - line.predict(point.co2_ppm)) ** 2 for point in points)


def print_pooled_fit(points: list[DecayPoint], line: Line) -> None:
    """dC/dt = a + b*C, so k = -b and C_out = -a/b."""
    count = len(points)
    leak = -line.slope
    outdoor_ppm = -line.intercept / line.slope
    mean_slope = sum(point.slope_ppm_per_minute for point in points) / count
    total_sum_of_squares = sum((point.slope_ppm_per_minute - mean_slope) ** 2 for point in points)
    r_squared = 1 - residual_sum_of_squares(points, line) / total_sum_of_squares

    print()
    print("pooled fit  dC/dt = -k (C - C_out)")
    print(f"  k      = {leak:.5f} per minute   (model today: 0.027)")
    print(f"  C_out  = {outdoor_ppm:.0f} ppm       (model today: 420)")
    print(f"  R^2    = {r_squared:.3f} over {count:,} points")
    for setpoint_ppm in SETPOINTS_PPM:
        print(
            f"  decay at {setpoint_ppm:.0f} ppm = {leak * (setpoint_ppm - outdoor_ppm):.1f} ppm/min"
        )


def print_sink_shape(points: list[DecayPoint], line: Line) -> None:
    """Proportional sink against constant sink, judged on residuals."""
    rates = sorted(-point.slope_ppm_per_minute for point in points)
    mean_rate = sum(rates) / len(rates)
    constant_sum_of_squares = sum((rate - mean_rate) ** 2 for rate in rates)
    print()
    print("which shape does the data support?")
    print(
        f"  proportional  -k(C-C_out)   residual SS = {residual_sum_of_squares(points, line):,.0f}"
    )
    print(f"  constant      -R           residual SS = {constant_sum_of_squares:,.0f}")
    print(
        f"  constant R = {mean_rate:.1f} ppm/min"
        f"   median {rates[len(rates) // 2]:.1f}"
        f"   p10 {rates[len(rates) // 10]:.1f}"
        f"   p90 {rates[9 * len(rates) // 10]:.1f}"
    )


def print_monthly_fits(points: list[DecayPoint]) -> None:
    print()
    print("by month (decay is not one number - wind and dT drive it):")
    by_month: dict[str, list[DecayPoint]] = {}
    for point in points:
        by_month.setdefault(point.observed_at.strftime("%Y-%m"), []).append(point)
    for month in sorted(by_month):
        month_points = by_month[month]
        if len(month_points) < MIN_POINTS_PER_MONTH:
            continue
        line = fit_least_squares_line(to_xy(month_points))
        if line is None:
            continue
        print(
            f"  {month}  k={-line.slope:.5f}  C_out={-line.intercept / line.slope:>5.0f}"
            f"  n={len(month_points):,}"
        )


def main(path: str) -> int:
    rows = load(path)
    print(f"clean samples in window: {len(rows):,}")
    if not rows:
        return 1

    points = collect_decay_points(rows)
    print(f"decay points after the lag drains: {len(points):,}")
    if len(points) < MIN_DECAY_POINTS:
        print("not enough decay to fit")
        return 1

    line = fit_least_squares_line(to_xy(points))
    if line is None:
        print("not enough decay to fit")
        return 1
    print_pooled_fit(points, line)
    print_sink_shape(points, line)
    print_monthly_fits(points)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
