# Watchers

Throwaway-looking scripts that keep earning their place, so they live here
rather than being rewritten each time.

```bash
tools/watch/watch-sensor.sh      # CO2 fault rate, bucketed by temperature
```

## `watch-sensor.sh`

Reports the share of readings a node's sensor **refuses** - nulls, below-range,
above-range - and buckets it by temperature, because that is how the 2026-09-12
failure presented: flawless below 25 °C, 22% bad at 25-30, 26% at 30-35 and
40% above 35 °C.

It reports the band alongside the rate on purpose. Two outcomes look identical
in a single number and mean opposite things:

- the sensor never gets hot -> the symptom was avoided, the part is not cleared
- it gets hot and stays clean -> the part is genuinely fine

**When to run it:** after replacing or recalibrating a sensor, and on the first
hot day after either. Not overnight - the night branch of the rules engine reads
only temperature, so a CO2 fault between dusk and 06:30 has nothing to act on
and the watcher would just report "clean" into an empty room.

Known wart: a window with no data at all reports 0-of-0 as `clean`. The `NODATA`
band is the part to read.
