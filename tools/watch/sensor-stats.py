"""Read a readings payload on stdin, print: peak_temp bad_pct bad n band"""
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    print("0 0 0 0 nodata"); sys.exit()
if not rows:
    print("0 0 0 0 nodata"); sys.exit()
co2 = [r.get("co2") for r in rows]
temps = [r["temperature"] for r in rows if r.get("temperature") is not None]
# Bad = the sensor had no answer, or gave one outside the SCD41's own range.
bad = sum(1 for c in co2 if c is None or c < 400 or c > 5000)
t = max(temps) if temps else 0.0
band = "cool" if t < 25 else ("warm" if t < 30 else "hot")
print(f"{t:.1f} {round(100*bad/len(co2))} {bad} {len(co2)} {band}")
