"""DS18B20 probes via the kernel's w1 sysfs; see "DS18B20 probes" in the Linux Agent doc."""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple

from .sensor import (
    UNIT_CELSIUS,
    UNIT_PERCENT,
    UNIT_PPM,
    Measurement,
    RateGuard,
    Reading,
    SensorInfo,
    invalid,
)

log = logging.getLogger("tempestas.agent.ds18b20")

W1_ROOT = "/sys/bus/w1/devices"
SLAVE_FILE = "w1_slave"
DS18B20_FAMILY_GLOB = "28-*"
ROM_PATTERN = re.compile(r"^28-[0-9a-f]{12}$")

# The power-on reset value of the temperature register, in the kernel's millidegrees.
POWER_ON_RESET_MILLI_C = 85_000
MILLIDEGREES_PER_DEGREE = 1000

# Narrower than the chip's -55..125: outside these a fault is likelier than a pumphouse.
DEFAULT_MIN_C = -40.0
DEFAULT_MAX_C = 60.0

DEFAULT_MAX_CHANGE_C_PER_MIN = 10.0
CORROBORATE_WITHIN_C = 1.0

NOT_MEASURED = "NOT_MEASURED"
CRC_PASSED = "YES"
ZERO_BYTE = "00"
KERNEL_LINE_COUNT = 2

_TEMPERATURE = re.compile(r"t=(-?\d+)\s*$")


@dataclass(frozen=True)
class Probe:
    rom: str
    sensor_id: str


class FailureStreak(NamedTuple):
    reason_kind: str
    refused_reads: int


def parse_w1_slave(
    text: str, minimum_c: float = DEFAULT_MIN_C, maximum_c: float = DEFAULT_MAX_C
) -> Measurement:
    """Judge the kernel's two lines: `<scratchpad> : crc=57 YES` then `<scratchpad> t=23125`."""
    lines = text.strip().splitlines()
    if len(lines) < KERNEL_LINE_COUNT:
        return invalid(UNIT_CELSIUS, "SHORT_READ")

    status = lines[0].strip()
    if not status.endswith(CRC_PASSED):
        return invalid(UNIT_CELSIUS, "CRC_FAILED")

    scratchpad = status.split(":", 1)[0].split()
    if _is_all_zero(scratchpad):
        return invalid(UNIT_CELSIUS, "ALL_ZERO_SCRATCHPAD")

    match = _TEMPERATURE.search(lines[1])
    if not match:
        return invalid(UNIT_CELSIUS, "NO_TEMPERATURE")
    millidegrees = int(match.group(1))
    if millidegrees == POWER_ON_RESET_MILLI_C:
        return invalid(UNIT_CELSIUS, "POWER_ON_RESET (85.000)")

    celsius = millidegrees / MILLIDEGREES_PER_DEGREE
    if celsius < minimum_c:
        return invalid(UNIT_CELSIUS, f"BELOW_RANGE ({celsius} < {minimum_c})")
    if celsius > maximum_c:
        return invalid(UNIT_CELSIUS, f"ABOVE_RANGE ({celsius} > {maximum_c})")
    return Measurement(round(celsius, 2), True, UNIT_CELSIUS)


def _is_all_zero(scratchpad: list[str]) -> bool:
    return bool(scratchpad) and all(byte == ZERO_BYTE for byte in scratchpad)


class Ds18b20Sensors:
    """Every configured probe on the 1-Wire bus, read once per cycle."""

    def __init__(
        self,
        probes: tuple[Probe, ...],
        w1_root: str | Path = W1_ROOT,
        max_change_c_per_min: float = DEFAULT_MAX_CHANGE_C_PER_MIN,
        monotonic=time.monotonic,
    ) -> None:
        self._probes = probes
        self._root = Path(w1_root)
        self._monotonic = monotonic
        # Per probe, so one probe's spike never becomes another's reference.
        self._guards = {
            probe.sensor_id: RateGuard(
                max_change_per_min=max_change_c_per_min,
                corroborate_within=CORROBORATE_WITHIN_C,
                unit=UNIT_CELSIUS,
            )
            for probe in probes
            if max_change_c_per_min > 0
        }
        # Logging only on a change keeps a dead probe from writing a line every cycle all winter.
        self._failing: dict[str, FailureStreak] = {}

    def start(self) -> None:
        if not self._root.is_dir():
            # Not fatal: the heater relays' failsafe does not need a thermometer.
            log.error(
                "no 1-Wire bus at %s: is dtoverlay=w1-gpio set in config.txt? "
                "No temperatures will be published.",
                self._root,
            )
            return
        present = {device.name for device in self._root.glob(DS18B20_FAMILY_GLOB)}
        self._report_missing_probes(present)
        self._report_unconfigured_probes(present)

    def sensors(self) -> list[SensorInfo]:
        return [SensorInfo(probe.sensor_id, "ds18b20", ("temperature",)) for probe in self._probes]

    def read_all(self) -> list[tuple[str, Reading]]:
        readings = []
        for probe in self._probes:
            temperature = self._read_probe(probe)
            if not temperature.valid:
                self._note_failure(probe, temperature.reason or "INVALID")
                continue
            self._note_success(probe)
            readings.append((probe.sensor_id, _temperature_only_reading(temperature)))
        return readings

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        names = ", ".join(f"{probe.sensor_id}={probe.rom}" for probe in self._probes)
        return f"ds18b20 @ {self._root} [{names}]"

    def _report_missing_probes(self, present: set[str]) -> None:
        for probe in self._probes:
            if probe.rom not in present:
                log.error("probe %s (%s) is not on the bus", probe.sensor_id, probe.rom)

    def _report_unconfigured_probes(self, present: set[str]) -> None:
        configured = {probe.rom for probe in self._probes}
        for rom in sorted(present - configured):
            log.warning("probe %s is on the bus but not configured; ignoring it", rom)

    def _read_probe(self, probe: Probe) -> Measurement:
        try:
            text = (self._root / probe.rom / SLAVE_FILE).read_text()
        except FileNotFoundError:
            return invalid(UNIT_CELSIUS, "PROBE_MISSING")
        except OSError as error:
            return invalid(UNIT_CELSIUS, f"READ_FAILED ({error})")

        temperature = parse_w1_slave(text)
        guard = self._guards.get(probe.sensor_id)
        if not temperature.valid or guard is None:
            return temperature
        is_plausible, reason = guard.judge(temperature.value, self._monotonic())
        return temperature if is_plausible else invalid(UNIT_CELSIUS, reason or "RATE_IMPLAUSIBLE")

    def _note_failure(self, probe: Probe, reason: str) -> None:
        previous = self._failing.get(probe.sensor_id)
        refused_reads = (previous.refused_reads if previous else 0) + 1
        # Compare the reason's name only: a rate refusal carries its rate, and that is not news.
        reason_kind = reason.split(" ", 1)[0]
        if previous is None or previous.reason_kind != reason_kind:
            log.warning("probe %s (%s) refused: %s", probe.sensor_id, probe.rom, reason)
        self._failing[probe.sensor_id] = FailureStreak(reason_kind, refused_reads)

    def _note_success(self, probe: Probe) -> None:
        previous = self._failing.pop(probe.sensor_id, None)
        if previous is not None:
            log.warning(
                "probe %s (%s) reading again after %d refused reads",
                probe.sensor_id,
                probe.rom,
                previous.refused_reads,
            )


def _temperature_only_reading(temperature: Measurement) -> Reading:
    # The contract keeps all three keys; a probe never could measure CO2, so it says so.
    return Reading(
        co2_ppm=invalid(UNIT_PPM, NOT_MEASURED),
        temperature_c=temperature,
        humidity_pct=invalid(UNIT_PERCENT, NOT_MEASURED),
    )
