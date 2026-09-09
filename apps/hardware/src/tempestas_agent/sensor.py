"""Sensor backends.

`Scd4xSensor` is a raw smbus2 driver derived from the greenhouse's own
`scd4x_healthcheck.py`, which has been correct on this hardware for a year.
Using it instead of `adafruit-circuitpython-scd4x` on Blinka drops a large
dependency tree (and its swig/liblgpio build requirements) and fixes a real bug:
the datasheet says data_ready is true when the LOW 11 BITS are non-zero, which
this checks and the Adafruit driver does not - it tests the whole word.

The rule both backends obey: **never invent a reading**. An implausible or
missing value is reported as invalid with a reason, never as a zero and never as
the last known good value. A dead sensor stuck on a low CO2 would otherwise run
a propane burner indefinitely.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol

# SCD4x command set, with the execution delays the datasheet requires.
_STOP_PERIODIC = 0x3F86
_REINIT = 0x3646
_GET_SERIAL = 0x3682
_SELF_TEST = 0x3639
_START_PERIODIC = 0x21B1
_GET_DATA_READY = 0xE4B8
_READ_MEASUREMENT = 0xEC05
_GET_TEMP_OFFSET = 0x2318
_SET_TEMP_OFFSET = 0x241D
_SET_ALTITUDE = 0x2427
_PERSIST_SETTINGS = 0x3615

# The datasheet's data_ready test: the low 11 bits, not the whole word.
_DATA_READY_MASK = 0x07FF


@dataclass(frozen=True)
class Measurement:
    value: float | None
    valid: bool
    unit: str
    reason: str | None = None


@dataclass(frozen=True)
class Reading:
    co2_ppm: Measurement
    temperature_c: Measurement
    humidity_pct: Measurement


def invalid(unit: str, reason: str) -> Measurement:
    return Measurement(value=None, valid=False, unit=unit, reason=reason)


class SensorBackend(Protocol):
    def start(self) -> None: ...
    def read(self) -> Reading | None:
        """A reading, or None when none is ready yet. Never a fabricated one."""
        ...

    def stop(self) -> None: ...
    def describe(self) -> str: ...


def crc8(data: bytes | list[int]) -> int:
    """Sensirion CRC-8: poly 0x31, init 0xFF."""
    crc = 0xFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def decode_words(raw: list[int]) -> list[int]:
    """Split a reply into 16-bit words, verifying the CRC of each."""
    words = []
    for i in range(0, len(raw), 3):
        hi, lo, crc = raw[i], raw[i + 1], raw[i + 2]
        if crc8([hi, lo]) != crc:
            raise OSError(f"CRC mismatch on word {i // 3}; comms are flaky")
        words.append((hi << 8) | lo)
    return words


def convert_temperature(raw_word: int) -> float:
    return -45 + 175 * raw_word / 65535


def convert_humidity(raw_word: int) -> float:
    return 100 * raw_word / 65535


class Scd4xSensor:
    """Raw I2C SCD4x. One sensor per bus address; all SCD4x share 0x62."""

    def __init__(self, bus: int, address: int, offset_c: float | None, altitude_m: int | None):
        self._bus_no = bus
        self._addr = address
        self._offset_c = offset_c
        self._altitude_m = altitude_m
        self._bus = None
        self.serial: str | None = None
        # Read back during start(), while the chip is still idle. An attribute
        # rather than a method because it CANNOT be read later: the SCD4x NACKs
        # every configuration command once periodic measurement is running, and
        # that surfaces as a Remote I/O error rather than a wrong answer.
        self.applied_offset_c: float | None = None

    def start(self) -> None:
        from smbus2 import SMBus

        self._bus = SMBus(self._bus_no)
        # The chip may be mid periodic-measurement from a previous run, and
        # every configuration command is rejected while it is.
        self._send(_STOP_PERIODIC, exec_ms=500, tolerate=True)
        self._send(_REINIT, exec_ms=30, tolerate=True)

        self.serial = "".join(f"{w:04x}" for w in self._read_words(_GET_SERIAL, 3))

        # Applied every startup rather than trusted to persist. The old code set
        # it through a driver that never called persist_settings, so it has
        # almost certainly been lost to every power cycle since.
        if self._offset_c is not None:
            self._send(_SET_TEMP_OFFSET, arg=self._encode_offset(self._offset_c))
        if self._altitude_m is not None:
            self._send(_SET_ALTITUDE, arg=self._altitude_m)

        # Read the offset back BEFORE measurement starts: this is the only
        # window the chip will answer in, and an offset that silently failed to
        # apply is exactly the failure this re-applying exists to catch.
        self.applied_offset_c = round(175 * self._read_words(_GET_TEMP_OFFSET, 1)[0] / 65535, 2)

        self._send(_START_PERIODIC)

    def read(self) -> Reading | None:
        if not (self._read_words(_GET_DATA_READY, 1)[0] & _DATA_READY_MASK):
            return None
        co2_raw, t_raw, rh_raw = self._read_words(_READ_MEASUREMENT, 3)

        # A zero CO2 is the sensor's way of saying it has no answer. Reporting
        # it as 0 ppm would read as "extremely low", which is the one direction
        # that runs the burner.
        co2 = (
            Measurement(float(co2_raw), True, "ppm")
            if 0 < co2_raw < 40000
            else invalid("ppm", "ZERO_READING" if co2_raw == 0 else "OUT_OF_RANGE")
        )
        return Reading(
            co2_ppm=co2,
            temperature_c=Measurement(round(convert_temperature(t_raw), 2), True, "C"),
            humidity_pct=Measurement(round(convert_humidity(rh_raw), 1), True, "%"),
        )

    def self_test(self) -> int:
        """0x0000 is a pass. Takes about 10 seconds."""
        return self._read_words(_SELF_TEST, 1, exec_ms=10_000)[0]

    def persist_settings(self) -> None:
        self._send(_PERSIST_SETTINGS, exec_ms=800)

    def stop(self) -> None:
        if self._bus is None:
            return
        self._send(_STOP_PERIODIC, exec_ms=500, tolerate=True)
        self._bus.close()
        self._bus = None

    def describe(self) -> str:
        offset = "unknown" if self.applied_offset_c is None else f"{self.applied_offset_c:.2f}C"
        return (
            f"scd4x @ i2c-{self._bus_no}:0x{self._addr:02x} "
            f"serial={self.serial or 'unknown'} offset={offset}"
        )

    @staticmethod
    def _encode_offset(offset_c: float) -> int:
        return int(round(offset_c * 65535 / 175)) & 0xFFFF

    def _send(self, cmd: int, arg: int | None = None, exec_ms: int = 1, tolerate: bool = False):
        from smbus2 import i2c_msg

        payload = [(cmd >> 8) & 0xFF, cmd & 0xFF]
        if arg is not None:
            word = [(arg >> 8) & 0xFF, arg & 0xFF]
            payload += word + [crc8(word)]
        try:
            self._bus.i2c_rdwr(i2c_msg.write(self._addr, payload))
        except OSError:
            # Only the idle-forcing commands at startup tolerate a refusal; a
            # failure anywhere else must surface.
            if not tolerate:
                raise
        time.sleep(exec_ms / 1000.0)

    def _read_words(self, cmd: int, nwords: int, exec_ms: int = 1) -> list[int]:
        from smbus2 import i2c_msg

        self._send(cmd, exec_ms=exec_ms)
        msg = i2c_msg.read(self._addr, nwords * 3)
        self._bus.i2c_rdwr(msg)
        return decode_words(list(msg))


class SimulatedSensor:
    """A closed loop, not a random number generator.

    Temperature follows a diurnal curve and CO2 decays toward ambient, both
    pushed by whatever the simulated relays are doing. That makes "burner on ->
    CO2 climbs -> the rule turns it off" observable with no hardware, which is
    what lets the whole stack be exercised on a laptop.
    """

    def __init__(
        self,
        gpio=None,
        burner_pin: int = 16,
        fan_pin: int = 20,
        start_minutes: int = 360,
    ):
        self._gpio = gpio
        self._burner_pin = burner_pin
        self._fan_pin = fan_pin
        self._minutes = start_minutes
        self._temperature = 18.0
        self._co2 = 600.0
        self._humidity = 55.0

    def start(self) -> None:
        return None

    def read(self) -> Reading:
        import math

        burner = self._line_energised(self._burner_pin)
        fan = self._line_energised(self._fan_pin)

        self._minutes = (self._minutes + 1) % (24 * 60)
        diurnal = 18 + 7 * math.sin(((self._minutes - 300) / 1440) * 2 * math.pi)

        delta = (diurnal - self._temperature) * 0.05 + (0.25 if burner else 0) - (0.4 if fan else 0)
        self._temperature = round(self._temperature + delta, 2)

        co2_delta = -8 + (45 if burner else 0) - (30 if fan else 0)
        self._co2 = max(400.0, min(2500.0, self._co2 + co2_delta))
        self._humidity = max(20.0, min(95.0, self._humidity + (-0.5 if fan else 0.2)))

        return Reading(
            co2_ppm=Measurement(round(self._co2), True, "ppm"),
            temperature_c=Measurement(self._temperature, True, "C"),
            humidity_pct=Measurement(round(self._humidity, 1), True, "%"),
        )

    def _line_energised(self, pin: int) -> bool:
        # Four of the five relays are active-LOW, so 0 means energised.
        return self._gpio is not None and self._gpio.level(pin) == 0

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        return "simulated scd4x (closed loop)"
