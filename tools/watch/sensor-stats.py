"""Read a readings payload on stdin, print: peak_temp bad_pct bad n band"""

import json
import sys

NO_DATA_LINE = "0 0 0 0 nodata"
SCD41_MIN_PPM = 400
SCD41_MAX_PPM = 5000
WARM_FROM_C = 25
HOT_FROM_C = 30


def is_bad_co2(co2_ppm: float | None) -> bool:
    return co2_ppm is None or co2_ppm < SCD41_MIN_PPM or co2_ppm > SCD41_MAX_PPM


def classify_band(peak_temp_c: float) -> str:
    if peak_temp_c < WARM_FROM_C:
        return "cool"
    if peak_temp_c < HOT_FROM_C:
        return "warm"
    return "hot"


def summarise(readings: list[dict]) -> str:
    co2_values = [reading.get("co2") for reading in readings]
    temperatures = [
        reading["temperature"] for reading in readings if reading.get("temperature") is not None
    ]
    bad_count = sum(1 for co2_ppm in co2_values if is_bad_co2(co2_ppm))
    peak_temp_c = max(temperatures) if temperatures else 0.0
    bad_pct = round(100 * bad_count / len(co2_values))
    return f"{peak_temp_c:.1f} {bad_pct} {bad_count} {len(co2_values)} {classify_band(peak_temp_c)}"


def main() -> None:
    try:
        readings = json.load(sys.stdin)
    except Exception:
        print(NO_DATA_LINE)
        return
    if not readings:
        print(NO_DATA_LINE)
        return
    print(summarise(readings))


if __name__ == "__main__":
    main()
