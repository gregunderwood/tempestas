#!/usr/bin/env python3
"""Find the VPD at which this greenhouse actually assimilates the most carbon.

    uv run python fit/fit_vpd_response.py readings.json \
        --transitions transitions.json --lights 07:00-19:00

The published 1.2-1.6 kPa band is somebody else's crop in somebody else's
house. This measures yours, using the fact that a sealed greenhouse is a
whole-plant gas exchange chamber: CO2 falling under light IS photosynthesis,
and the rate it falls at is the number to maximise.

Two stages, because the second is meaningless without the first.

CALIBRATION, at night
---------------------
In the dark with the burner off there is no photosynthesis, so

    dC/dt = k (C_out - C) + R

with k the leak coefficient and R respiration. Both are unknown, but dC/dt is
observed across a RANGE of C as the house fills overnight - so regressing
dC/dt against C gives the slope -k and, from the intercept, R.

This matters more than it looks. The 0.034 leak coefficient in
greenhouse-model.json was fitted from DAYTIME decay with a live crop, so it
already has photosynthesis baked into it. Using it to correct for leakage and
then extracting photosynthesis would be circular, and would report an
assimilation near zero no matter what the plants were doing.

MEASUREMENT, under light
------------------------
With the burner off and the lights on,

    N = k (C_out - C) - dC/dt

This N is NET uptake, not gross assimilation. The full balance for a lit
sealed house is dC/dt = k(C_out - C) + R - A, so the expression above equals
A - R: photosynthesis less respiration. Respiration is deliberately not added
back. Net is what the crop actually removes from the air and what growth
tracks, and the daytime R is not the night R anyway - leaves respire in the
light and the soil is warmer - so adding the night figure would trade a clean
measured quantity for a worse-founded estimate of a gross one.

Each window yields one (VPD, A) pair. Plot A against VPD: it climbs while the
stomata are open and rolls over when the plant starts closing them. The peak is
the answer, and the roll-over is the ceiling worth staying under.

What this cannot separate
-------------------------
Light level and temperature move with VPD over a day and both drive A on their
own. Windows are therefore reported with their light hour and temperature so
like can be compared with like - a single day's curve will mostly be measuring
the sun. Several days, and comparing windows at matched hour and temperature,
is what makes it a VPD curve rather than a daylight curve.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta, timezone

LOCAL = timezone(timedelta(hours=-7))


# Background CO2 the greenhouse leaks toward. Global average is ~420 ppm; the
# site sits in a valley with no nearby traffic, and the canopy sensor bottoms
# out near 440 on a well-ventilated afternoon, so 420 is the right order and
# the fits are not sensitive to +/-20.
OUTDOOR_PPM = 420.0


def es_kpa(temp_c: float) -> float:
    """Saturation vapour pressure, kPa. Magnus, the form the docs use."""
    return 0.6112 * math.exp((17.62 * temp_c) / (243.12 + temp_c))


def vpd_kpa(temp_c: float, rh_pct: float, leaf_offset_c: float) -> float:
    """Leaf vapour pressure deficit.

    The air inside a leaf is saturated at LEAF temperature, which under lamps
    runs above air temperature - by ~2 C in still air, ~1 C with strong canopy
    airflow. The plant responds to this gradient, not to the air-only one.
    """
    return es_kpa(temp_c + leaf_offset_c) - (rh_pct / 100.0) * es_kpa(temp_c)


@dataclass(frozen=True)
class Sample:
    at: datetime
    temp_c: float
    rh_pct: float
    co2_ppm: float


@dataclass(frozen=True)
class Window:
    """One usable stretch of readings, reduced to the numbers that matter."""

    start: datetime
    minutes: float
    co2_mid: float
    dcdt: float          # ppm/min, signed
    vpd: float
    temp_c: float
    n: int


def robust_slope(samples: list[Sample]) -> float | None:
    """Theil-Sen slope in ppm/min, over minute-medians.

    Two deliberate choices, both learned the hard way.

    Minute-medians first: the SCD41 reports every 10s as an integer, and
    overnight drift is around 0.5 ppm/min - about 0.08 ppm per sample. Nearly
    every consecutive pair differs by zero, so any estimator built on adjacent
    samples reads exactly 0 no matter how long the window is. Collapsing to
    one median per minute spends the sampling rate on noise rejection instead
    of on a resolution it cannot deliver. Median, not mean, because a single
    489 ppm spike (2026-09-13) would drag a minute's mean by 80 ppm.

    Theil-Sen over pairs spanning at least a quarter of the window: the
    baseline has to be long enough that the real change clears the noise.
    Pairs of neighbours are where the previous version of this went wrong.
    """
    buckets: dict[int, list[float]] = {}
    t0 = samples[0].at
    for s in samples:
        minute = int((s.at - t0).total_seconds() // 60)
        buckets.setdefault(minute, []).append(s.co2_ppm)
    pts = sorted((m, statistics.median(v)) for m, v in buckets.items())
    if len(pts) < 8:
        return None

    min_gap = max(2.0, (pts[-1][0] - pts[0][0]) / 4.0)
    slopes = [
        (b[1] - a[1]) / (b[0] - a[0])
        for i, a in enumerate(pts)
        for b in pts[i + 1:]
        if b[0] - a[0] >= min_gap
    ]
    return statistics.median(slopes) if len(slopes) >= 8 else None


def fit_line(points: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Least squares y = a + b x, returning (a, b, r2)."""
    n = len(points)
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    denom = n * sxx - sx * sx
    b = (n * sxy - sx * sy) / denom
    a = (sy - b * sx) / n
    mean = sy / n
    ss_tot = sum((p[1] - mean) ** 2 for p in points)
    ss_res = sum((p[1] - (a + b * p[0])) ** 2 for p in points)
    return a, b, (1 - ss_res / ss_tot if ss_tot else 0.0)


def fit_line_robust(
    points: list[tuple[float, float]],
) -> tuple[float, float, float, list[int]]:
    """Theil-Sen line: (intercept, slope, r2 over inliers, outlier indices).

    Least squares is not safe here. The calibration runs on 10-20 window
    points, and one bad window - an unlogged burner span, a door opened at
    dawn - lands far off the trend and drags the slope with it. A synthetic
    night with ten clean points and one such outlier fitted +0.028 by least
    squares where the truth was -0.005: not merely wrong, sign-inverted.
    Theil-Sen takes the median of pairwise slopes, so a minority of bad
    windows cannot move it, and recovers -0.00501 on that same input.

    r2 is then measured over inliers only. Against every point it would be
    dominated by the very outliers the fit was built to ignore - the same
    synthetic scores -0.36 that way, rejecting a fit that was correct to
    three digits. Outliers are returned rather than discarded quietly: a
    window that does not fit a dark sealed house is usually telling you
    something happened in the greenhouse, and that is worth printing.
    """
    slopes = [
        (b[1] - a[1]) / (b[0] - a[0])
        for i, a in enumerate(points)
        for b in points[i + 1:]
        if b[0] != a[0]
    ]
    if not slopes:
        return 0.0, 0.0, 0.0, []
    slope = statistics.median(slopes)
    intercept = statistics.median(y - slope * x for x, y in points)

    resid = [y - (intercept + slope * x) for x, y in points]
    mad = statistics.median(abs(r) for r in resid)
    # 1.4826 puts MAD on the same scale as a standard deviation for normal
    # noise; 3.5 of those is loose enough not to trim honest scatter.
    limit = 3.5 * 1.4826 * mad if mad > 0 else float("inf")
    outliers = [i for i, r in enumerate(resid) if abs(r) > limit]

    inliers = [p_ for i, p_ in enumerate(points) if i not in set(outliers)]
    if len(inliers) < 3:
        return intercept, slope, 0.0, outliers
    mean = statistics.fmean(y for _, y in inliers)
    ss_tot = sum((y - mean) ** 2 for _, y in inliers)
    ss_res = sum((y - (intercept + slope * x)) ** 2 for _, (x, y) in enumerate(inliers))
    return intercept, slope, (1 - ss_res / ss_tot if ss_tot else 0.0), outliers


def load_samples(path: str) -> list[Sample]:
    out = []
    with open(path) as fh:
        raw = json.load(fh)
    for r in raw:
        if r.get("co2") is None or r.get("temperature") is None:
            continue
        if r.get("humidity") is None:
            continue
        out.append(
            Sample(
                at=datetime.fromisoformat(r["createdAt"].replace("Z", "+00:00")),
                temp_c=float(r["temperature"]),
                rh_pct=float(r["humidity"]),
                co2_ppm=float(r["co2"]),
            )
        )
    out.sort(key=lambda s: s.at)
    return out


def burner_spans(path: str | None, pin: int) -> list[tuple[datetime, datetime]]:
    """When the burner was ENERGISED, from the recorded relay history.

    Reads `energised` rather than `level`: the level that means on is per
    device, and BCM 26 on the far end is active-HIGH while everything else is
    active-LOW.
    """
    if not path:
        return []
    with open(path) as fh:
        raw = json.load(fh)
    rows = sorted(
        (datetime.fromisoformat(r["observedAt"].replace("Z", "+00:00")), r["energised"])
        for r in raw
        if r["pin"] == pin and r["energised"] is not None
    )
    spans, opened = [], None
    for at, on in rows:
        if on and opened is None:
            opened = at
        elif not on and opened is not None:
            spans.append((opened, at))
            opened = None
    if opened is not None:
        spans.append((opened, datetime.now(UTC)))
    return spans


def burner_quiet(at: datetime, spans, settle_min: float) -> bool:
    """True when the burner is off AND has been for long enough to stop counting.

    The transport lag means CO2 keeps arriving for minutes after the relay
    opens - measured at 1.6 min to the overshoot peak. A window that starts too
    soon after a burn is measuring the tail of the burn, not the crop.
    """
    settle = timedelta(minutes=settle_min)
    return all(not (a <= at <= b + settle) for a, b in spans)


def windows(
    samples: list[Sample],
    spans,
    *,
    minutes: float,
    lights: tuple[time, time] | None,
    dark: bool,
    leaf_offset: float,
    settle_min: float,
) -> list[Window]:
    out: list[Window] = []
    span = timedelta(minutes=minutes)
    i = 0
    while i < len(samples):
        start = samples[i].at
        chunk = [s for s in samples if start <= s.at < start + span]
        if len(chunk) < 20:
            i += 1
            continue
        local = start.astimezone(LOCAL).time()
        lit = lights is not None and lights[0] <= local < lights[1]
        if dark == lit:                       # wrong half of the day
            i += len(chunk)
            continue
        if not all(burner_quiet(s.at, spans, settle_min) for s in chunk):
            i += len(chunk)
            continue
        rate = robust_slope(chunk)
        if rate is None:
            i += len(chunk)
            continue
        out.append(
            Window(
                start=start,
                minutes=minutes,
                co2_mid=statistics.median([s.co2_ppm for s in chunk]),
                dcdt=rate,
                vpd=statistics.median(
                    [vpd_kpa(s.temp_c, s.rh_pct, leaf_offset) for s in chunk]
                ),
                temp_c=statistics.median([s.temp_c for s in chunk]),
                n=len(chunk),
            )
        )
        i += len(chunk)
    return out


def main() -> int:
    p = argparse.ArgumentParser(prog="fit_vpd_response")
    p.add_argument("readings", help="tempestas readings JSON")
    p.add_argument("--transitions", help="pin_transitions JSON (burner state)")
    p.add_argument("--pin", type=int, default=5, help="burner GPIO pin")
    p.add_argument("--lights", default="07:00-19:00", help="HH:MM-HH:MM local")
    p.add_argument("--window", type=float, default=15.0,
                   help="minutes per measurement window")
    p.add_argument("--after", help="ignore measurement windows before this local "
                                   "time, e.g. '2026-09-24 07:00'")
    p.add_argument("--before", help="ignore measurement windows after this local time")
    p.add_argument("--calib-window", type=float, default=60.0,
                   help="minutes per night-calibration window; long by default "
                        "because overnight drift is slow and needs the baseline")
    p.add_argument("--leaf-offset", type=float, default=1.0,
                   help="leaf minus air, C. ~1 with strong airflow, ~2 still")
    p.add_argument("--settle", type=float, default=8.0,
                   help="minutes to ignore after the burner stops")
    p.add_argument("--leak-k", type=float,
                   help="known leak coefficient /min, skipping night calibration")
    args = p.parse_args()

    a, b = args.lights.split("-")
    lights = (time.fromisoformat(a), time.fromisoformat(b))

    samples = load_samples(args.readings)
    if not samples:
        print("no usable readings")
        return 1
    spans = burner_spans(args.transitions, args.pin)
    print(f"{len(samples)} readings  {samples[0].at.astimezone(LOCAL):%m-%d %H:%M}"
          f" -> {samples[-1].at.astimezone(LOCAL):%m-%d %H:%M}")
    print(f"{len(spans)} burner spans; lights {args.lights}")

    # ---- stage 1: calibrate leak and respiration in the dark -------------
    night = windows(samples, spans, minutes=args.calib_window, lights=lights, dark=True,
                    leaf_offset=args.leaf_offset, settle_min=args.settle)
    print(f"\nCALIBRATION - {len(night)} dark windows")
    if len(night) < 6:
        print("  too few to fit. Need a night with the burner off and CO2 moving.")
        return 1
    pts = [(w.co2_mid, w.dcdt) for w in night]
    spread = max(p_[0] for p_ in pts) - min(p_[0] for p_ in pts)
    intercept, slope, r2, outliers = fit_line_robust(pts)
    k = -slope
    print(f"  CO2 spanned {spread:.0f} ppm across the dark windows")
    print(f"  dC/dt = {intercept:+.3f} {slope:+.5f} * C      R2 = {r2:.3f}"
          f"  ({len(pts) - len(outliers)}/{len(pts)} windows)")
    for i in outliers:
        w = night[i]
        print(f"    rejected {w.start.astimezone(LOCAL):%m-%d %H:%M}  "
              f"C={w.co2_mid:.0f} dC/dt={w.dcdt:+.2f} - something happened here")

    if args.leak_k is not None:
        k = args.leak_k
        print(f"  overridden: k = {k:.5f} /min (--leak-k)")
    elif spread < 150:
        eq = statistics.median([w.co2_mid for w in night])
        print()
        print(f"  NOT SEPARABLE: CO2 only moved {spread:.0f} ppm and sat near {eq:.0f} ppm.")
        print("  At equilibrium respiration exactly balances leakage, so dC/dt is ~0")
        print("  at every concentration and there is no slope to fit. All such a")
        print(f"  night tells you is the ratio  R = k x ({eq:.0f} - {OUTDOOR_PPM:.0f})"
              f" = {eq - OUTDOOR_PPM:.0f} k")
        print()
        print("  Either the sensor is flat-lining (check it), or this really was a")
        print("  settled night - in which case perturb it: run the burner at night")
        print("  to ~1200 ppm and let it decay in the dark, where dC/dt varies with")
        print("  C and both constants fall out of one regression.")
        print()
        print("  Once you have it:  --leak-k <value>")
        return 1
    elif k <= 0 or r2 < 0.25:
        print()
        print(f"  POOR FIT (R2 = {r2:.2f}): CO2 moved, but not in a way the leak model")
        print("  explains. Usual causes: a vent or door opened during the night, the")
        print("  burner ran without being logged, or the window is too short for the")
        print(f"  drift ({args.calib_window:.0f} min - try --calib-window 90).")
        return 1
    c_out_plus_r = intercept / k
    print(f"  leak coefficient k ......... {k:.5f} /min")
    print(f"  (C_out + R/k) .............. {c_out_plus_r:.0f} ppm")
    print(f"  With outdoor air near {OUTDOOR_PPM:.0f} ppm, the excess is respiration:")
    resp = intercept - k * OUTDOOR_PPM
    print(f"  respiration R .............. {resp:+.2f} ppm/min")

    # ---- stage 2: assimilation under light -------------------------------
    day = windows(samples, spans, minutes=args.window, lights=lights, dark=False,
                  leaf_offset=args.leaf_offset, settle_min=args.settle)
    if args.after or args.before:
        # Applied to the measurement stage only: calibration still wants the
        # whole night, while the sealed run being measured is a few hours
        # inside it.
        lo = datetime.fromisoformat(args.after).replace(tzinfo=LOCAL) if args.after else None
        hi = datetime.fromisoformat(args.before).replace(tzinfo=LOCAL) if args.before else None
        day = [w for w in day
               if (lo is None or w.start >= lo) and (hi is None or w.start <= hi)]

    print(f"\nMEASUREMENT - {len(day)} lit windows with the burner quiet")

    # The mass balance only closes on a sealed house. An open vent or a running
    # exhaust fan exchanges air far faster than the sealed-night k, so
    # k(C_out - C) understates removal by an order of magnitude and every
    # assimilation figure below becomes noise around zero.
    #
    # Neither the vents nor the legacy exhaust fan are logged, so infer it:
    # a lit greenhouse full of plants that is holding station near outdoor air
    # is being ventilated, because a sealed one would be drawn well below it.
    # Pinned NEAR outdoor is the tell, not merely low: a sealed house drawn
    # below ambient is proof of sealing, since incoming air cannot pull it
    # there. Only the band around outdoor is ambiguous, and inside that band
    # assimilation is CO2-limited anyway, so little is lost by refusing it.
    lit_co2 = statistics.median([w.co2_mid for w in day]) if day else 0.0
    if day and OUTDOOR_PPM - 40 <= lit_co2 <= OUTDOOR_PPM + 150:
        print(f"  median CO2 across those windows: {lit_co2:.0f} ppm")
        print()
        print("  REFUSING TO FIT - the greenhouse was open.")
        print(f"  Lit, planted, and still sitting near outdoor air ({OUTDOOR_PPM:.0f} ppm)")
        print("  means air was being exchanged far faster than the sealed-night")
        print(f"  k of {k:.5f}/min. The leak term would understate removal by an")
        print("  order of magnitude and every assimilation figure would be noise.")
        print()
        print("  Assimilation is only measurable on a closed house: vents shut,")
        print("  exhaust fans off, CO2 drawn down from an enriched start. That is")
        print("  the same sealed run being planned for the humidity question, so")
        print("  capture this from it - a couple of lit hours sealed, with the")
        print("  burner left off once the house is charged, is enough.")
        return 1
    if not day:
        print("  none. The burner may be running through the whole photoperiod.")
        return 1
    print(f"  {'when':>11} {'VPD':>6} {'temp':>6} {'CO2':>6} {'dC/dt':>8} {'net':>8}")
    rows = []
    for w in day:
        # net uptake (A - R); see the module docstring on why R is not added
        assim = k * (OUTDOOR_PPM - w.co2_mid) - w.dcdt
        rows.append((w, assim))
        print(f"  {w.start.astimezone(LOCAL):%m-%d %H:%M} {w.vpd:>6.2f} "
              f"{w.temp_c:>5.1f}C {w.co2_mid:>6.0f} {w.dcdt:>+8.1f} {assim:>+8.1f}")

    # ---- the curve --------------------------------------------------------
    print("\nNET CO2 UPTAKE vs VPD  (ppm/min, higher is better)")
    bins: dict[float, list[float]] = {}
    for w, assim in rows:
        bins.setdefault(round(w.vpd * 4) / 4, []).append(assim)
    for vpd in sorted(bins):
        v = bins[vpd]
        bar = "#" * max(0, int(statistics.median(v)))
        print(f"  {vpd:>5.2f} kPa  n={len(v):<3} median {statistics.median(v):>+7.1f}  {bar}")
    best = max(bins, key=lambda k_: statistics.median(bins[k_]))
    print(f"\n  best bin: {best:.2f} kPa")
    print("  Treat one day's curve as provisional - light, temperature and CO2")
    print("  itself all move with VPD across a drawdown. Compare windows at")
    print("  matched hour, temperature and CO2 across several days before")
    print("  believing a peak.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
