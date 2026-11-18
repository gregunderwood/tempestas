"""DS18B20 1-Wire temperature probes, read through the kernel's w1 sysfs.

The pumphouse node: two or three waterproof probes on one bus (BCM4, the
`w1-gpio` overlay), each published as its own sensor so the server can take the
coldest of them.

Every probe is pinned by its ROM id, never by discovery order. Order on the bus
is the order the kernel happened to find them in, and a probe swapped after a
failure would silently take over another's name - the same reason GPIO chips
are chosen by label.

The rule is the one every backend obeys: **never invent a reading.** The chip
has three well-known ways of producing a plausible number that is not a
measurement, and each is refused by name:

- `85.000` is the power-on reset value of the temperature register. A probe
  that browned out between conversions returns it with a valid CRC.
- An all-zero scratchpad passes the CRC (the CRC of zeros is zero) and decodes
  as exactly 0 °C. That is what a shorted or stuck-low data line reads as, and
  0 °C is a perfectly believable pumphouse temperature.
- A CRC the kernel marks `NO` is a corrupted transfer, usually a long or noisy
  cable or a missing pull-up.

A refused probe is simply absent from that cycle. The server's health check
names a sensor that has gone quiet, and its rules carry on with the probes that
remain.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path

from .sensor import Measurement, RateGuard, Reading, SensorInfo, invalid

log = logging.getLogger("tempestas.agent.ds18b20")

W1_ROOT = "/sys/bus/w1/devices"

# DS18B20 family code. Clones report the same family, which is fine: what is
# refused below is a behaviour, not a vendor.
ROM_PATTERN = re.compile(r"^28-[0-9a-f]{12}$")

# The power-on reset value of the temperature register, in the kernel's
# millidegrees.
POWER_ON_RESET_MILLI_C = 85_000

# The chip's own range is -55 to +125. These are narrower on purpose: outside
# them the reading is far more likely to be a fault than a pumphouse.
DEFAULT_MIN_C = -40.0
DEFAULT_MAX_C = 60.0

NOT_MEASURED = "NOT_MEASURED"

_TEMPERATURE = re.compile(r"t=(-?\d+)\s*$")


@dataclass(frozen=True)
class Probe:
    rom: str
    sensor_id: str


def parse_w1_slave(text: str, lo: float = DEFAULT_MIN_C, hi: float = DEFAULT_MAX_C) -> Measurement:
    """Judge the two lines the kernel returns for one conversion.

    72 01 4b 46 7f ff 0e 10 57 : crc=57 YES
    72 01 4b 46 7f ff 0e 10 57 t=23125
    """
    lines = text.strip().splitlines()
    if len(lines) < 2:
        return invalid("C", "SHORT_READ")

    status = lines[0].strip()
    if not status.endswith("YES"):
        return invalid("C", "CRC_FAILED")

    scratchpad = status.split(":", 1)[0].split()
    if scratchpad and all(b == "00" for b in scratchpad):
        return invalid("C", "ALL_ZERO_SCRATCHPAD")

    match = _TEMPERATURE.search(lines[1])
    if not match:
        return invalid("C", "NO_TEMPERATURE")
    milli = int(match.group(1))
    if milli == POWER_ON_RESET_MILLI_C:
        return invalid("C", "POWER_ON_RESET (85.000)")

    celsius = milli / 1000
    if celsius < lo:
        return invalid("C", f"BELOW_RANGE ({celsius} < {lo})")
    if celsius > hi:
        return invalid("C", f"ABOVE_RANGE ({celsius} > {hi})")
    return Measurement(round(celsius, 2), True, "C")


class Ds18b20Sensors:
    """Every configured probe on the 1-Wire bus, read once per cycle."""

    def __init__(
        self,
        probes: tuple[Probe, ...],
        w1_root: str | Path = W1_ROOT,
        max_c_per_min: float = 10.0,
        monotonic=time.monotonic,
    ) -> None:
        self._probes = probes
        self._root = Path(w1_root)
        self._monotonic = monotonic
        # A pipe in a steel sleeve cannot move ten degrees in a minute; a glitch
        # can. Zero disables it. Per probe, so one probe's spike never becomes
        # another's reference.
        self._guards = {
            p.sensor_id: RateGuard(
                max_ppm_per_min=max_c_per_min,
                corroborate_within_ppm=1.0,
                unit="C",
            )
            for p in probes
            if max_c_per_min > 0
        }
        # The reason each probe is currently failing, or absent when it is not.
        # Logging only on a change keeps a dead probe from writing a line every
        # ten seconds for the rest of the winter.
        self._failing: dict[str, tuple[str, int]] = {}

    def start(self) -> None:
        if not self._root.is_dir():
            # Not fatal. The agent still owns the heater relays, and their
            # failsafe does not need a thermometer.
            log.error(
                "no 1-Wire bus at %s: is dtoverlay=w1-gpio set in config.txt? "
                "No temperatures will be published.",
                self._root,
            )
            return
        present = {p.name for p in self._root.glob("28-*")}
        for probe in self._probes:
            if probe.rom not in present:
                log.error("probe %s (%s) is not on the bus", probe.sensor_id, probe.rom)
        for rom in sorted(present - {p.rom for p in self._probes}):
            # Listed nowhere, so published nowhere. Plugging a probe in must not
            # change what the rules read until somebody names it.
            log.warning("probe %s is on the bus but not configured; ignoring it", rom)

    def sensors(self) -> list[SensorInfo]:
        return [SensorInfo(p.sensor_id, "ds18b20", ("temperature",)) for p in self._probes]

    def read_all(self) -> list[tuple[str, Reading]]:
        out = []
        for probe in self._probes:
            temperature = self._read_probe(probe)
            if not temperature.valid:
                self._note_failure(probe, temperature.reason or "INVALID")
                continue
            self._note_success(probe)
            out.append(
                (
                    probe.sensor_id,
                    Reading(
                        # The contract keeps all three measurement keys. A probe
                        # does not fail to measure CO2, it never could - so
                        # it says that rather than leaving the key out.
                        co2_ppm=invalid("ppm", NOT_MEASURED),
                        temperature_c=temperature,
                        humidity_pct=invalid("%", NOT_MEASURED),
                    ),
                )
            )
        return out

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        names = ", ".join(f"{p.sensor_id}={p.rom}" for p in self._probes)
        return f"ds18b20 @ {self._root} [{names}]"

    def _read_probe(self, probe: Probe) -> Measurement:
        try:
            text = (self._root / probe.rom / "w1_slave").read_text()
        except FileNotFoundError:
            return invalid("C", "PROBE_MISSING")
        except OSError as err:
            return invalid("C", f"READ_FAILED ({err})")

        temperature = parse_w1_slave(text)
        guard = self._guards.get(probe.sensor_id)
        if temperature.valid and guard is not None:
            ok, reason = guard.judge(temperature.value, self._monotonic())
            if not ok:
                return invalid("C", reason or "RATE_IMPLAUSIBLE")
        return temperature

    def _note_failure(self, probe: Probe, reason: str) -> None:
        previous = self._failing.get(probe.sensor_id)
        count = (previous[1] if previous else 0) + 1
        # Compare the reason's name only: a rate refusal carries the rate, and
        # every new number is not news.
        kind = reason.split(" ", 1)[0]
        if previous is None or previous[0] != kind:
            log.warning("probe %s (%s) refused: %s", probe.sensor_id, probe.rom, reason)
        self._failing[probe.sensor_id] = (kind, count)

    def _note_success(self, probe: Probe) -> None:
        previous = self._failing.pop(probe.sensor_id, None)
        if previous is not None:
            log.warning(
                "probe %s (%s) reading again after %d refused reads",
                probe.sensor_id,
                probe.rom,
                previous[1],
            )
