#!/usr/bin/env python3
"""Fit gross output, transport lag and sink against elantris's own trace; see README.md.

uv run python fit/fit_burner.py <readings.json> [transitions.json]
"""

from __future__ import annotations

import json
import math
import sys
from datetime import UTC, datetime
from typing import NamedTuple

# Fallback only: observed by eye at 30-second polling, the uncertainty that made the fit fail.
ON_WINDOWS_LOCAL = [
    ("2026-09-10 17:26", "2026-09-10 17:41"),
    ("2026-09-10 17:48", "2026-09-10 17:54"),
    ("2026-09-10 18:03", "2026-09-10 18:10"),
    ("2026-09-10 18:20", "2026-09-10 18:27"),
]
LOCAL_OFFSET_HOURS = 7
SECONDS_PER_HOUR = 3600
SECONDS_PER_MINUTE = 60.0

BURNER_NODE_ID = "elantris"
BURNER_PIN = 5

MAX_SAMPLE_GAP_MINUTES = 2.0
LEAD_IN_SECONDS = 60
TAIL_SECONDS = 8 * 60
MIN_SEGMENT_SAMPLES = 3

GROSS_GRID_PPM_PER_MINUTE = range(20, 141, 2)
LAG_GRID_TENTHS_OF_MINUTE = range(5, 61)
SINK_GRID_HALF_PPM_PER_MINUTE = range(4, 61, 2)

Span = tuple[float, float]
Sample = tuple[float, float]


class GridFit(NamedTuple):
    rms_ppm: float
    gross_ppm_per_minute: float
    lag_minutes: float
    sink_ppm_per_minute: float


def parse_utc_timestamp(text: str) -> float:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()


def local_to_utc_seconds(local_text: str) -> float:
    naive = datetime.fromisoformat(local_text).replace(tzinfo=UTC)
    return naive.timestamp() + LOCAL_OFFSET_HOURS * SECONDS_PER_HOUR


def load_on_spans(path: str, node_id: str, pin: int) -> list[Span]:
    """On-windows from the recorded relay history, by `energised` since polarity is per device."""
    with open(path) as transitions_file:
        transitions = json.load(transitions_file)
    events = sorted(
        (parse_utc_timestamp(transition["observedAt"]), transition["energised"])
        for transition in transitions
        if transition["nodeId"] == node_id
        and transition["pin"] == pin
        and transition["energised"] is not None
    )
    spans: list[Span] = []
    opened: float | None = None
    for observed_at, is_energised in events:
        if is_energised and opened is None:
            opened = observed_at
        elif not is_energised and opened is not None:
            spans.append((opened, observed_at))
            opened = None
    # A burn still running at the end is dropped rather than closed at an invented time.
    return spans


def load_readings(path: str) -> list[Sample]:
    with open(path) as readings_file:
        readings = json.load(readings_file)
    samples = [
        (parse_utc_timestamp(reading["createdAt"]), float(reading["co2"]))
        for reading in readings
        if reading.get("co2") is not None
    ]
    samples.sort()
    return samples


def list_boundaries(on_spans: list[Span]) -> list[float]:
    return sorted(edge for span in on_spans for edge in span)


def is_burner_on(at: float, on_spans: list[Span]) -> bool:
    return any(start <= at < end for start, end in on_spans)


def simulate_rms_error(
    series: list[Sample],
    on_spans: list[Span],
    gross: float,
    lag_minutes: float,
    sink: float,
) -> float:
    """Replay the known relay state, re-anchored at every transition so drift is not judged."""
    boundaries = list_boundaries(on_spans)
    modelled_ppm = series[0][1]
    in_flight_ppm = 0.0
    squared_error = 0.0
    compared = 0
    next_boundary = 0
    for index in range(1, len(series)):
        previous_at, _ = series[index - 1]
        current_at, observed_ppm = series[index]
        step_minutes = (current_at - previous_at) / SECONDS_PER_MINUTE
        if step_minutes <= 0 or step_minutes > MAX_SAMPLE_GAP_MINUTES:
            modelled_ppm = observed_ppm
            continue
        while next_boundary < len(boundaries) and boundaries[next_boundary] <= previous_at:
            modelled_ppm = series[index - 1][1]
            next_boundary += 1
        if is_burner_on(previous_at, on_spans):
            in_flight_ppm += gross * step_minutes
        drained = in_flight_ppm * (1.0 - math.exp(-step_minutes / lag_minutes))
        in_flight_ppm -= drained
        modelled_ppm += drained - sink * step_minutes
        squared_error += (modelled_ppm - observed_ppm) ** 2
        compared += 1
    return math.sqrt(squared_error / compared) if compared else float("inf")


def search_grid(series: list[Sample], on_spans: list[Span]) -> GridFit:
    best: GridFit | None = None
    for gross_step in GROSS_GRID_PPM_PER_MINUTE:
        for lag_step in LAG_GRID_TENTHS_OF_MINUTE:
            for sink_step in SINK_GRID_HALF_PPM_PER_MINUTE:
                gross, lag, sink = float(gross_step), lag_step / 10.0, sink_step / 2.0
                rms = simulate_rms_error(series, on_spans, gross, lag, sink)
                if best is None or rms < best.rms_ppm:
                    best = GridFit(rms, gross, lag, sink)
    return best


def choose_on_spans(transitions_path: str | None) -> list[Span]:
    if transitions_path:
        on_spans = load_on_spans(transitions_path, BURNER_NODE_ID, BURNER_PIN)
        print(f"relay history: {len(on_spans)} burns, from the recorded log")
        return on_spans
    print("relay history: NONE - falling back to windows observed by eye at")
    print("  30-second resolution. Expect the three constants to stay")
    print("  non-identifiable; see fit/README.md.")
    return [
        (local_to_utc_seconds(start), local_to_utc_seconds(end)) for start, end in ON_WINDOWS_LOCAL
    ]


def select_labelled_window(series: list[Sample], on_spans: list[Span]) -> list[Sample]:
    """From just before the first commanded ON; anything earlier has no known relay state."""
    start = on_spans[0][0] - LEAD_IN_SECONDS
    end = on_spans[-1][1] + TAIL_SECONDS
    return [sample for sample in series if start <= sample[0] <= end]


def print_segment_rates(series: list[Sample], on_spans: list[Span]) -> None:
    """Model-free, and what actually decided the constants."""
    print()
    print("observed rates per segment (no model)")
    print(f"  {'state':5} {'window':13} {'ppm/min':>8}  {'peak':>6}")
    edges = [series[0][0], *list_boundaries(on_spans), series[-1][0]]
    for segment_start, segment_end in zip(edges, edges[1:], strict=False):
        segment = [sample for sample in series if segment_start <= sample[0] <= segment_end]
        if len(segment) < MIN_SEGMENT_SAMPLES:
            continue
        minutes = (segment[-1][0] - segment[0][0]) / SECONDS_PER_MINUTE
        state = "ON " if is_burner_on(segment[0][0], on_spans) else "OFF"
        local_start = segment[0][0] - LOCAL_OFFSET_HOURS * SECONDS_PER_HOUR
        when = datetime.fromtimestamp(local_start, UTC).strftime("%H:%M")
        rate = (segment[-1][1] - segment[0][1]) / minutes
        peak = max(co2_ppm for _, co2_ppm in segment)
        print(f"  {state:5} {when} +{minutes:4.1f}m   {rate:>+8.1f}  {peak:>6.0f}")


def print_grid_fit(fit: GridFit) -> None:
    print()
    print("grid search - NOT IDENTIFIABLE, read the caveat below")
    print(f"  G   gross production = {fit.gross_ppm_per_minute:.0f} ppm/min   (model now: 88)")
    print(f"  tau transport lag    = {fit.lag_minutes:.1f} min     (model now: 4.5)")
    print(
        f"  S   total removal    = {fit.sink_ppm_per_minute:.1f} ppm/min"
        "  (model now: 37 at 1500 ppm)"
    )
    print(f"  RMS error            = {fit.rms_ppm:.1f} ppm")

    print()
    print("  CAVEAT: these three trade off against each other and 70 minutes of")
    print("  data with +-30 s transition times cannot separate them. Re-anchoring")
    print("  the trajectory moves gross output between 88 and 118 ppm/min. Treat")
    print("  this block as a consistency check, not as the source of a constant.")


def print_model_constants() -> None:
    print()
    print("what the segment rates give, which is what the model uses")
    print("  gross output  88 ppm/min   the one long burn, 387->1454 in 14.8 min")
    print("  transport lag 4.5 min      near-setpoint burns net only +4..+16 ppm/min,")
    print("                             and the peak lands 2-3 min AFTER the OFF")
    print("  removal@1500  37 ppm/min   duty cycle is sink/gross and nothing else:")
    print("                             44% measured x 88 gross")
    print()
    print("  To do better, log relay transitions alongside readings.")


def main(readings_path: str, transitions_path: str | None = None) -> int:
    series = load_readings(readings_path)
    on_spans = choose_on_spans(transitions_path)
    if not on_spans:
        print("no burns in the window")
        return 1
    series = select_labelled_window(series, on_spans)
    print(f"samples in the labelled window: {len(series)}")
    print(
        f"  {datetime.fromtimestamp(series[0][0], UTC)} .. "
        f"{datetime.fromtimestamp(series[-1][0], UTC)}"
    )

    best = search_grid(series, on_spans)
    print_segment_rates(series, on_spans)
    print_grid_fit(best)
    print_model_constants()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
