#!/usr/bin/env python3
"""Fit the burner against elantris's own trace, where relay state is KNOWN.

    uv run python fit/fit_burner.py <readings.json>

Why not the 2025 export: that is a different appliance at a different point in
the greenhouse, and it carries no relay history at all - burner state there can
only be inferred from the shape it is supposed to explain. This window is the
one place both halves are known: elantris's 10-second readings, and the four
on/off transitions observed live on 2026-09-10.

Fits three numbers together, because they trade off against each other and
fitting them one at a time just moves the error around:

    G    gross production, ppm/min at the sensor once alight
    tau  transport lag, minutes (ignition plus mixing)
    S    everything that REMOVES CO2 - leak, ventilation and the crop

The 2025 season puts S at 18.4 ppm/min on the far end with a p10-p90 of
3.5-37.7, so this is fitted rather than assumed, and the answer is expected to
land inside that range rather than match its mean.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import UTC, datetime

# Observed live, local time, +-30 s (the watcher polled every 30 s).
ON_WINDOWS_LOCAL = [
    ("2026-09-10 17:26", "2026-09-10 17:41"),
    ("2026-09-10 17:48", "2026-09-10 17:54"),
    ("2026-09-10 18:03", "2026-09-10 18:10"),
    ("2026-09-10 18:20", "2026-09-10 18:27"),
]
LOCAL_OFFSET_H = 7  # America/Vancouver, PDT


def to_utc(s: str) -> float:
    """Local wall-clock string -> POSIX seconds. Returns a timestamp, not a datetime."""
    naive = datetime.fromisoformat(s).replace(tzinfo=UTC)
    return naive.timestamp() + LOCAL_OFFSET_H * 3600


def load(path: str) -> list[tuple[float, float]]:
    with open(path) as fh:
        rows = json.load(fh)
    out = []
    for r in rows:
        if r.get("co2") is None:
            continue
        ts = datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")).timestamp()
        out.append((ts, float(r["co2"])))
    out.sort()
    return out


def boundaries(on_spans) -> list[float]:
    out = []
    for a, b in on_spans:
        out.extend((a, b))
    return sorted(out)


def simulate(series, on_spans, g: float, tau: float, s: float) -> float:
    """Replay the known relay state and return RMS error against the trace.

    Re-anchored to the observed value at every transition. Left free-running,
    an hour of integration drifts on accumulated error and the fit ends up
    judging the drift rather than the slopes - which are the thing the
    constants actually control. in_flight deliberately carries across, because
    it is physical state, not a fitting artefact.
    """
    bounds = boundaries(on_spans)
    c = series[0][1]
    in_flight = 0.0
    err2 = 0.0
    n = 0
    bi = 0
    for i in range(1, len(series)):
        t0, _ = series[i - 1]
        t1, observed = series[i]
        dt = (t1 - t0) / 60.0
        if dt <= 0 or dt > 2.0:
            c = observed
            continue
        while bi < len(bounds) and bounds[bi] <= t0:
            c = series[i - 1][1]
            bi += 1
        on = any(a <= t0 < b for a, b in on_spans)
        if on:
            in_flight += g * dt
        drained = in_flight * (1.0 - math.exp(-dt / tau))
        in_flight -= drained
        c += drained - s * dt
        err2 += (c - observed) ** 2
        n += 1
    return math.sqrt(err2 / n) if n else float("inf")


def main(path: str) -> int:
    series = load(path)
    on_spans = [(to_utc(a), to_utc(b)) for a, b in ON_WINDOWS_LOCAL]
    # Start at the first commanded ON; everything before it is the tail of an
    # earlier event and has no known relay state.
    start = on_spans[0][0] - 60
    end = on_spans[-1][1] + 8 * 60
    series = [p for p in series if start <= p[0] <= end]
    print(f"samples in the labelled window: {len(series)}")
    print(f"  {datetime.fromtimestamp(series[0][0], UTC)} .. "
          f"{datetime.fromtimestamp(series[-1][0], UTC)}")

    best = None
    for gi in range(20, 141, 2):                  # 20..140 ppm/min
        for taui in range(5, 61):                 # 0.5..6.0 min
            for si in range(4, 61, 2):            # 2..30 ppm/min
                g, tau, s = float(gi), taui / 10.0, si / 2.0
                rms = simulate(series, on_spans, g, tau, s)
                if best is None or rms < best[0]:
                    best = (rms, g, tau, s)
    rms, g, tau, s = best
    print()
    print("best fit (grid search, all three together)")
    print(f"  G   gross production = {g:.0f} ppm/min   (model today: 91)")
    print(f"  tau transport lag    = {tau:.1f} min     (model today: 2.5)")
    print(f"  S   total removal    = {s:.1f} ppm/min  (model today: 29 at 1500 ppm)")
    print(f"  RMS error            = {rms:.1f} ppm")

    print()
    print("what that implies")
    print(f"  net charge while alight = {g - s:.0f} ppm/min")
    print(f"  in-flight at steady state = {g * tau:.0f} ppm  (the overshoot after OFF)")
    duty = s / g
    print(f"  duty cycle to hold a setpoint = {100 * duty:.0f}%  (measured that night: 44%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
