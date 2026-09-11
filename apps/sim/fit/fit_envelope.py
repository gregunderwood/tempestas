#!/usr/bin/env python3
"""Fit the greenhouse ENVELOPE from the 2025 season, not the burner.

    uv run python fit/fit_envelope.py <greenhouse-readings.csv.gz>

What this can and cannot answer
-------------------------------
The export is the far-end sensor watching the far-end generator: a different
appliance from elantris's, measured at a different point in the greenhouse. So
its burner output does NOT transfer.

What does transfer is the envelope. Leakage is a property of the structure -
the same glass, the same gaps - and it is the constant the duty-cycle gap most
likely turns on: 5 min on / 12 min off simulated against 7 on / 9 off measured.
A leak that is too weak makes the burner look too strong.

There is no relay history in the legacy database, so burner state is inferred
from the trace itself. That is fine for decay: a long, smooth, monotonic fall
can only be leakage, whatever caused the peak before it.

Method
------
Decay segments only, and only after the transport lag has drained, then a
least-squares fit of

    dC/dt = -k * (C - C_out)

over all of them. Both k and C_out fall out of one linear regression, which
means the outdoor baseline is measured here rather than assumed.
"""

from __future__ import annotations

import gzip
import sys
from datetime import datetime

# The season the burner ran the same scenario as now. After 2025-11-01
# enrichment stops dead and the trace is flat at the winter baseline.
WINDOW_START = datetime(2025, 8, 23)
WINDOW_END = datetime(2025, 11, 2)

SAMPLE_S = 10.0
SMOOTH_SAMPLES = 6           # 1 minute; the SCD41 quantises to 1 ppm
DERIV_SAMPLES = 6            # slope over 1 minute
LAG_DRAIN_MIN = 5.0          # skip the transport lag draining after burner-off
MIN_SEGMENT_MIN = 4.0        # a decay worth fitting
FALLING_PPM_PER_MIN = -1.0   # what counts as falling
# Only the ENRICHED regime. Below this the fall is dominated by photosynthetic
# draw-down toward ambient, which is a different process with a different
# shape; pooling the two produced R^2 = 0.015 and a negative outdoor baseline.
MIN_ENRICHED_PPM = 900.0


def load(path: str) -> list[tuple[datetime, float]]:
    rows: list[tuple[datetime, float]] = []
    with gzip.open(path, "rt") as fh:
        next(fh)
        for line in fh:
            ts_s, _temp, _rh, co2_s = line.rstrip("\n").split(",")
            if not co2_s:
                continue
            co2 = float(co2_s)
            # The known-bad rows: 20 impossible highs on 2025-08-26, plus a
            # few implausible lows. 0.21% of the window.
            if co2 > 5000 or co2 < 300:
                continue
            ts = datetime.fromisoformat(ts_s)
            naive = ts.replace(tzinfo=None)
            if not (WINDOW_START <= naive < WINDOW_END):
                continue
            rows.append((ts, co2))
    rows.sort(key=lambda r: r[0])
    return rows


def smooth(values: list[float], width: int) -> list[float]:
    out, acc = [], 0.0
    for i, v in enumerate(values):
        acc += v
        if i >= width:
            acc -= values[i - width]
        out.append(acc / min(i + 1, width))
    return out


def main(path: str) -> int:
    rows = load(path)
    print(f"clean samples in window: {len(rows):,}")
    if not rows:
        return 1

    times = [r[0] for r in rows]
    co2 = smooth([r[1] for r in rows], SMOOTH_SAMPLES)

    # Slope in ppm/min over a 1-minute window, only where samples are contiguous.
    pts: list[tuple[float, float, datetime]] = []   # (C, dC/dt, when)
    falling_for = 0.0
    for i in range(DERIV_SAMPLES, len(rows)):
        dt_min = (times[i] - times[i - DERIV_SAMPLES]).total_seconds() / 60.0
        if not (0.5 <= dt_min <= 2.0):        # a gap; restart the run
            falling_for = 0.0
            continue
        slope = (co2[i] - co2[i - DERIV_SAMPLES]) / dt_min

        if slope > FALLING_PPM_PER_MIN:
            falling_for = 0.0
            continue
        falling_for += dt_min / DERIV_SAMPLES

        # Wait out the transport lag, and stay in the enriched regime.
        if falling_for < LAG_DRAIN_MIN:
            continue
        if co2[i] < MIN_ENRICHED_PPM:
            continue
        pts.append((co2[i], slope, times[i]))

    print(f"decay points after the lag drains: {len(pts):,}")
    if len(pts) < 100:
        print("not enough decay to fit")
        return 1

    # dC/dt = a + b*C   ->   k = -b,  C_out = -a/b
    n = len(pts)
    sx = sum(p[0] for p in pts)
    sy = sum(p[1] for p in pts)
    sxx = sum(p[0] * p[0] for p in pts)
    sxy = sum(p[0] * p[1] for p in pts)
    denom = n * sxx - sx * sx
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    k = -b
    c_out = -a / b

    mean_y = sy / n
    ss_tot = sum((p[1] - mean_y) ** 2 for p in pts)
    ss_res = sum((p[1] - (a + b * p[0])) ** 2 for p in pts)
    r2 = 1 - ss_res / ss_tot

    print()
    print("pooled fit  dC/dt = -k (C - C_out)")
    print(f"  k      = {k:.5f} per minute   (model today: 0.027)")
    print(f"  C_out  = {c_out:.0f} ppm       (model today: 420)")
    print(f"  R^2    = {r2:.3f} over {n:,} points")

    # Monthly, because leakage is not one number - wind and the indoor/outdoor
    # temperature difference drive it, and both change across a season.
    # What the fit says the greenhouse does at the setpoint, which is the
    # number to compare against elantris's own measurement.
    for level in (1200.0, 1500.0, 1600.0):
        print(f"  decay at {level:.0f} ppm = {k * (level - c_out):.1f} ppm/min")

    # Which SHAPE the data actually supports. A proportional sink and a constant
    # one are very different models; pick between them on residuals, not taste.
    rates = [-sl for _c, sl, _t in pts]
    rates.sort()
    mean_r = sum(rates) / len(rates)
    ss_const = sum((r - mean_r) ** 2 for r in rates)
    print()
    print("which shape does the data support?")
    print(f"  proportional  -k(C-C_out)   residual SS = {ss_res:,.0f}")
    print(f"  constant      -R           residual SS = {ss_const:,.0f}")
    print(f"  constant R = {mean_r:.1f} ppm/min"
          f"   median {rates[len(rates)//2]:.1f}"
          f"   p10 {rates[len(rates)//10]:.1f}"
          f"   p90 {rates[9*len(rates)//10]:.1f}")

    print()
    print("by month (decay is not one number - wind and dT drive it):")
    by_month: dict[str, list[tuple[float, float]]] = {}
    for c, slope_, t in pts:
        by_month.setdefault(t.strftime("%Y-%m"), []).append((c, slope_))
    for month in sorted(by_month):
        g = by_month[month]
        if len(g) < 50:
            continue
        m = len(g)
        gsx = sum(p[0] for p in g); gsy = sum(p[1] for p in g)
        gsxx = sum(p[0] * p[0] for p in g); gsxy = sum(p[0] * p[1] for p in g)
        gd = m * gsxx - gsx * gsx
        if gd == 0:
            continue
        gb = (m * gsxy - gsx * gsy) / gd
        ga = (gsy - gb * gsx) / m
        print(f"  {month}  k={-gb:.5f}  C_out={-ga/gb:>5.0f}  n={m:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
