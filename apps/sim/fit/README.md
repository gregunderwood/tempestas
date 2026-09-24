# Fitting the model from real data

Two scripts, two very different kinds of evidence. Neither is run automatically:
constants change when somebody decides they should, and the provenance in
`greenhouse-model.json` records which run a number came from.

```bash
# the envelope, from a season of the far end
uv run python fit/fit_envelope.py greenhouse-readings.csv.gz

# the burner. With a transitions file the on/off windows come from the
# RECORDED relay history; without one it falls back to windows observed by
# eye at 30-second resolution, which is what made the constants
# non-identifiable in the first place.
curl -s 'http://elantris:7000/api/devices/transitions?nodeId=elantris&from=...' \
  -o transitions.json
uv run python fit/fit_burner.py elantris-burn.json transitions.json
```

## Why they are separate

`fit_envelope.py` reads the 2025 season — 619,174 clean samples between
2025-08-23 and 2025-11-01, the last period the far-end generator ran the same
scenario. It has **no relay history at all**, so burner state can only be
inferred from the shape it is meant to explain. That is fine for decay: a long
smooth monotonic fall can only be removal, whatever caused the peak.

`fit_burner.py` reads elantris's own 10-second readings across the four on/off
transitions observed live on 2026-09-10. It is the only data where both halves
are known.

## What the 2025 season actually showed

A **negative result worth keeping**: decay does not scale with concentration in
any way the data can detect. A proportional sink and a constant one differ by
0.5% in residuals over 16,744 points. Decay averages 18.4 ppm/min with a p10–p90
of **3.5 to 37.7** — a tenfold spread that is real physics (vents, wind, light,
crop stage), not noise.

So the proportional shape in the model is _assumed_, not measured. It is kept
because it behaves correctly at the boundary — a constant sink would drive CO2
below outdoor air, which cannot happen — not because the data prefers it.

It also showed elantris's own measured decay (22–32 ppm/min) sits at the upper
end of the far end's distribution, which is what you would expect from a
ventilated entrance versus a sheltered canopy. That is a consistency check
passing, and a reason **not** to import the far end's mean into elantris's zone.

## What the burner fit changed

|                     | before     | after   |
| ------------------- | ---------- | ------- |
| Gross output        | 91 ppm/min | **88**  |
| Transport lag       | 2.5 min    | **4.5** |
| Removal at 1500 ppm | 29 ppm/min | **37**  |

The lag was the big error. Near the setpoint a 7-minute burn nets only
+4 to +16 ppm/min, because most of the output is still in transit when the
burner is commanded off — it arrives afterwards as the overshoot, which peaks
**2–3 minutes after** the command. Model that lag too short and the burner looks
far stronger near the setpoint than it is.

The other lesson: **duty cycle is sink ÷ gross and nothing else.** The transport
lag stretches a cycle but cannot change its ratio, so no amount of lag tuning
would ever have closed the 29%-vs-44% gap.

## What still cannot be fitted

Gross output, lag and sink are not simultaneously identifiable from 70 minutes
of data whose transitions are known only to ±30 s — the grid search moved gross
between 88 and 118 depending on how the trajectory was anchored.

**Log relay transitions alongside readings.** That now exists - see
`pin_transitions` in [Database](../../../docs/Infrastructure/Database.md) - so
the next fit can pass a transitions file and stop guessing. One properly logged
night should settle all three.

## `fit_vpd_response.py` — what VPD this greenhouse actually likes

Two stages, because the second is meaningless without the first.

**Stage 1, calibration.** Dark, sealed, burner off: `dC/dt = k(C_out − C) + R`.
Regress `dC/dt` against `C` and the leak coefficient and respiration both drop
out. This has to be measured, not borrowed — see below.

**Stage 2, measurement.** Lit and sealed, burner quiet:
`N = k(C_out − C) − dC/dt`, binned against leaf VPD. `N` is **net** uptake
(photosynthesis less respiration). Night `R` is deliberately not added back;
daytime respiration is not the night figure, so doing so would trade a measured
quantity for a guessed one.

```sh
python fit/export_legacy.py --from 2026-09-23 --to 2026-09-25 -o canopy.json
python fit/fit_vpd_response.py canopy.json --transitions trans.json \
    --after '2026-10-03 07:00' --before '2026-10-03 12:00'
```

### Use the canopy sensor, not elantris

The first run of this used elantris and failed: overnight CO2 sat flat at
730 ppm with no trend, so every window slope was ~0 and the regression was
degenerate. The canopy sensor over the very same night traced a clean approach
to equilibrium, 574 → 808 ppm, flattening by 03:00. elantris is by the north
entrance in its own microclimate with a degrading SCD4x; the canopy sensor is in
the air the plants are in. Its history lives in the legacy Flask Postgres on
`greenhouse` (`econ.sensor_reading`, one sensor, `sensor_id` null) back to
2025-08-23, which `export_legacy.py` pulls.

### The leak coefficient is two numbers, not one

| regime                          | k /min     |
| ------------------------------- | ---------- |
| daytime, ventilating, live crop | 0.034      |
| **sealed night, measured**      | **0.0045** |

A factor of 7.6, and not a contradiction: the 0.034 is an _effective_ removal
rate with photosynthesis and open vents folded into it. It is fine for
simulating a normal day and the simulator is tuned against it. It is useless
here, because subtracting it to recover what the plants are doing would assume
the answer. Enrichment economics also differ by nearly an order of magnitude
between the two regimes.

### Two estimator bugs worth not repeating

**Median of consecutive-sample differences reads exactly zero.** The SCD41
reports every 10 s as an integer; overnight drift of 0.5 ppm/min is 0.08 ppm per
sample, so nearly every adjacent pair differs by 0 and the median is 0 no matter
how long the window. Fixed by collapsing to minute-medians and running Theil–Sen
over pairs spanning at least a quarter of the window. At 15 and 30 min the old
version returned small-count noise that merely _looked_ like a fit — worse than
failing.

**Least squares on 10–20 window points is not safe.** One bad window — an
unlogged burner span, a door opened at dawn — drags the slope. On a synthetic
night with ten clean points and one outlier, least squares fitted +0.028 where
the truth was −0.005: sign-inverted. Theil–Sen recovered −0.00501 and R = 1.99
against a true 2.00. Fit quality is scored over inliers, and rejected windows
are printed rather than dropped quietly — a window that does not fit a dark
sealed house usually means something happened in the greenhouse.

### It refuses more often than it answers, on purpose

Neither 2026-09-23 nor 09-24 could be fitted. Through both photoperiods CO2 sat
at 450–500 ppm — outdoor air — because the house was open. The mass balance only
closes when it is shut, so the tool refuses rather than reporting the noise
around zero as a VPD curve.

Nor can it be fitted while the burner is cycling to hold a setpoint: at ~7.8 min
on / 7.3 min off, no gap clears the 8-minute transport-lag settle, and the
07:00–09:00 enriched window yielded **zero** usable windows.

**So the protocol is: seal the house, charge it to ~1400 ppm, then leave the
burner off and let it draw down under light.** A couple of hours is enough. That
is the same sealed run already planned for the humidity question — one run
answers both.
