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
