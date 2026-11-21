"""Sensor backends. The rule they all obey: never invent a reading."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Protocol

from .world_client import WorldUnreachable

UNIT_PPM = "ppm"
UNIT_CELSIUS = "C"
UNIT_PERCENT = "%"

_STOP_PERIODIC = 0x3F86
_REINITIALIZE = 0x3646
_GET_SERIAL = 0x3682
_SELF_TEST = 0x3639
_START_PERIODIC = 0x21B1
_GET_DATA_READY = 0xE4B8
_READ_MEASUREMENT = 0xEC05
_GET_TEMPERATURE_OFFSET = 0x2318
_SET_TEMPERATURE_OFFSET = 0x241D
_SET_ALTITUDE = 0x2427
_PERFORM_FRC = 0x362F
_SET_ASC = 0x2416
_GET_ASC = 0x2313
_PERSIST_SETTINGS = 0x3615

# The datasheet's execution time per command; anything unlisted needs 1 ms.
_EXECUTION_TIME_MS = {
    _STOP_PERIODIC: 500,
    _REINITIALIZE: 30,
    _SELF_TEST: 10_000,
    _PERFORM_FRC: 400,
    _PERSIST_SETTINGS: 800,
}
_DEFAULT_EXECUTION_TIME_MS = 1

# The datasheet's data_ready test: the low 11 bits, not the whole word.
_DATA_READY_MASK = 0x07FF

_SERIAL_WORD_COUNT = 3
_MEASUREMENT_WORD_COUNT = 3
_BYTES_PER_WORD_WITH_CRC = 3
_BYTE_MASK = 0xFF
_WORD_MASK = 0xFFFF
_WORD_FULL_SCALE = 65535
_TEMPERATURE_FLOOR_C = -45
_TEMPERATURE_SPAN_C = 175
_HUMIDITY_SPAN_PCT = 100

_CRC8_INITIAL = 0xFF
_CRC8_POLYNOMIAL = 0x31
_CRC8_HIGH_BIT = 0x80
_BITS_PER_BYTE = 8

# The chip offsets the FRC correction so an unsigned word can carry a negative one.
_FRC_CORRECTION_OFFSET = 0x8000
_FRC_REJECTED = 0xFFFF

_SCD4X_NO_ANSWER = 0
SECONDS_PER_MINUTE = 60.0
MILLISECONDS_PER_SECOND = 1000.0

DEFAULT_CO2_MIN_PPM = 300
DEFAULT_CO2_MAX_PPM = 5000
DEFAULT_MAX_CO2_CHANGE_PPM_PER_MIN = 400.0


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


@dataclass(frozen=True)
class SensorInfo:
    """One entry of `capabilities.sensors`: what a sensor is and what it measures."""

    sensor_id: str
    kind: str
    metrics: tuple[str, ...]


class SensorSet(Protocol):
    """One or more sensors sharing a bus and a read cycle, each published on its own topic."""

    def start(self) -> None: ...
    def sensors(self) -> list[SensorInfo]: ...
    def read_all(self) -> list[tuple[str, Reading]]:
        """A reading per sensor that has one. A sensor with nothing credible is absent."""
        ...

    def stop(self) -> None: ...
    def describe(self) -> str: ...


class SingleSensor:
    """Presents a one-reading backend (SCD4x, simulated, world) as a sensor set."""

    def __init__(self, backend: SensorBackend, sensor_info: SensorInfo) -> None:
        self.backend = backend
        self.sensor_info = sensor_info

    def start(self) -> None:
        self.backend.start()

    def sensors(self) -> list[SensorInfo]:
        return [self.sensor_info]

    def read_all(self) -> list[tuple[str, Reading]]:
        reading = self.backend.read()
        return [] if reading is None else [(self.sensor_info.sensor_id, reading)]

    def stop(self) -> None:
        self.backend.stop()

    def describe(self) -> str:
        return self.backend.describe()


class SensorBackend(Protocol):
    def start(self) -> None: ...
    def read(self) -> Reading | None:
        """A reading, or None when none is ready yet. Never a fabricated one."""
        ...

    def stop(self) -> None: ...
    def describe(self) -> str: ...


def crc8(message: bytes | list[int]) -> int:
    """Sensirion CRC-8."""
    crc = _CRC8_INITIAL
    for byte in message:
        crc ^= byte
        for _bit in range(_BITS_PER_BYTE):
            shifted = (crc << 1) & _BYTE_MASK
            crc = shifted ^ _CRC8_POLYNOMIAL if crc & _CRC8_HIGH_BIT else shifted
    return crc


def split_word(word: int) -> list[int]:
    return [(word >> 8) & _BYTE_MASK, word & _BYTE_MASK]


def decode_words(reply: list[int]) -> list[int]:
    """Split a reply into 16-bit words, verifying the CRC of each."""
    words = []
    for offset in range(0, len(reply), _BYTES_PER_WORD_WITH_CRC):
        high_byte, low_byte, crc = reply[offset], reply[offset + 1], reply[offset + 2]
        if crc8([high_byte, low_byte]) != crc:
            word_index = offset // _BYTES_PER_WORD_WITH_CRC
            raise OSError(f"CRC mismatch on word {word_index}; comms are flaky")
        words.append((high_byte << 8) | low_byte)
    return words


def convert_temperature(raw_word: int) -> float:
    return _TEMPERATURE_FLOOR_C + _TEMPERATURE_SPAN_C * raw_word / _WORD_FULL_SCALE


def convert_humidity(raw_word: int) -> float:
    return _HUMIDITY_SPAN_PCT * raw_word / _WORD_FULL_SCALE


def encode_temperature_offset(offset_c: float) -> int:
    return int(round(offset_c * _WORD_FULL_SCALE / _TEMPERATURE_SPAN_C)) & _WORD_MASK


def decode_temperature_offset(word: int) -> float:
    return round(_TEMPERATURE_SPAN_C * word / _WORD_FULL_SCALE, 2)


def judge_co2(raw: int, minimum_ppm: int, maximum_ppm: int) -> Measurement:
    """See "The CO2 range guard" in docs/Infrastructure/Linux Agent.md."""
    if raw == _SCD4X_NO_ANSWER:
        return invalid(UNIT_PPM, "ZERO_READING")
    if raw < minimum_ppm:
        return invalid(UNIT_PPM, f"BELOW_RANGE ({raw} < {minimum_ppm})")
    if raw > maximum_ppm:
        return invalid(UNIT_PPM, f"ABOVE_RANGE ({raw} > {maximum_ppm})")
    return Measurement(float(raw), True, UNIT_PPM)


class RateGuard:
    """Refuse impossible changes; see "The rate guard" in docs/Infrastructure/Linux Agent.md."""

    def __init__(
        self,
        max_change_per_min: float = DEFAULT_MAX_CO2_CHANGE_PPM_PER_MIN,
        max_gap_s: float = 120.0,
        resync_after: int = 3,
        corroborate_within: float = 60.0,
        unit: str = UNIT_PPM,
    ) -> None:
        self.unit = unit
        self.max_change_per_min = max_change_per_min
        self.max_gap_s = max_gap_s
        self.resync_after = resync_after
        self.corroborate_within = corroborate_within
        self._reference: tuple[float, float] | None = None
        self._consecutive_refusals = 0
        self._candidate: float | None = None

    def judge(self, value: float, observed_at: float) -> tuple[bool, str | None]:
        if self._reference is None:
            return self._accept(value, observed_at)

        reference_value, reference_at = self._reference
        elapsed_s = observed_at - reference_at
        if not self._is_usable_gap(elapsed_s):
            return self._accept(value, observed_at)

        rate = abs(value - reference_value) / (elapsed_s / SECONDS_PER_MINUTE)
        if rate <= self.max_change_per_min:
            return self._accept(value, observed_at)
        return self._refuse(value, observed_at, rate)

    def _is_usable_gap(self, elapsed_s: float) -> bool:
        return 0 < elapsed_s <= self.max_gap_s

    def _accept(self, value: float, observed_at: float) -> tuple[bool, None]:
        self._reference = (value, observed_at)
        self._consecutive_refusals = 0
        return True, None

    def _refuse(self, value: float, observed_at: float, rate: float) -> tuple[bool, str | None]:
        self._consecutive_refusals += 1
        refusal = f"RATE_IMPLAUSIBLE ({rate:.0f} {self.unit}/min > {self.max_change_per_min:.0f})"
        if self._consecutive_refusals < self.resync_after:
            return False, refusal
        if self._is_corroborated(value):
            self._candidate = None
            return self._accept(value, observed_at)
        self._candidate = value
        return False, f"{refusal}, awaiting corroboration"

    def _is_corroborated(self, value: float) -> bool:
        return (
            self._candidate is not None and abs(value - self._candidate) <= self.corroborate_within
        )


class Scd4xSensor:
    """Raw I2C SCD4x, derived from the greenhouse's own scd4x_healthcheck.py."""

    def __init__(
        self,
        bus: int,
        address: int,
        offset_c: float | None,
        altitude_m: int | None,
        co2_min_ppm: int = DEFAULT_CO2_MIN_PPM,
        co2_max_ppm: int = DEFAULT_CO2_MAX_PPM,
        asc_enabled: bool = False,
        max_change_ppm_per_min: float = DEFAULT_MAX_CO2_CHANGE_PPM_PER_MIN,
        monotonic=None,
    ):
        self._bus_number = bus
        self._address = address
        self._offset_c = offset_c
        self._altitude_m = altitude_m
        self._co2_min_ppm = co2_min_ppm
        self._co2_max_ppm = co2_max_ppm
        self._asc_enabled = asc_enabled
        self._monotonic = monotonic or time.monotonic
        self._rate_guard = RateGuard(max_change_ppm_per_min) if max_change_ppm_per_min > 0 else None
        self._bus = None
        self.serial: str | None = None
        # Captured in start(): the chip NACKs every configuration read once it is measuring.
        self.applied_offset_c: float | None = None
        self.applied_asc: bool | None = None

    def start(self) -> None:
        from smbus2 import SMBus

        self._bus = SMBus(self._bus_number)
        self._force_idle()
        self.serial = "".join(
            f"{word:04x}" for word in self._read_words(_GET_SERIAL, _SERIAL_WORD_COUNT)
        )
        self._apply_configuration()
        self._read_back_configuration()
        self.start_periodic_measurement()

    def read(self) -> Reading | None:
        if not self._is_data_ready():
            return None
        co2_word, temperature_word, humidity_word = self._read_words(
            _READ_MEASUREMENT, _MEASUREMENT_WORD_COUNT
        )
        return Reading(
            co2_ppm=self._judge_co2_word(co2_word),
            temperature_c=Measurement(
                round(convert_temperature(temperature_word), 2), True, UNIT_CELSIUS
            ),
            humidity_pct=Measurement(round(convert_humidity(humidity_word), 1), True, UNIT_PERCENT),
        )

    def self_test(self) -> int:
        """0x0000 is a pass. Takes about 10 seconds."""
        return self._read_words(_SELF_TEST, 1)[0]

    def forced_recalibration(self, target_ppm: int) -> int:
        # The caller must first run periodic measurement in the reference air for 3+ minutes.
        self.stop_periodic_measurement()
        raw = self._read_words(_PERFORM_FRC, 1, argument=target_ppm)[0]
        self.start_periodic_measurement()
        if raw == _FRC_REJECTED:
            raise OSError(
                "forced recalibration REJECTED by the sensor. The usual cause is "
                "too little time in the reference environment - it needs 3+ "
                "minutes of periodic measurement there first."
            )
        return raw - _FRC_CORRECTION_OFFSET

    def persist_settings(self) -> None:
        self._send(_PERSIST_SETTINGS)

    def stop_periodic_measurement(self) -> None:
        self._send(_STOP_PERIODIC, is_refusal_tolerated=True)

    def start_periodic_measurement(self) -> None:
        self._send(_START_PERIODIC)

    def stop(self) -> None:
        if self._bus is None:
            return
        self.stop_periodic_measurement()
        self._bus.close()
        self._bus = None

    def describe(self) -> str:
        offset = "unknown" if self.applied_offset_c is None else f"{self.applied_offset_c:.2f}C"
        return (
            f"scd4x @ i2c-{self._bus_number}:0x{self._address:02x} "
            f"serial={self.serial or 'unknown'} offset={offset} asc={self._describe_asc()}"
        )

    def _force_idle(self) -> None:
        # A previous run may have left it measuring, and it rejects configuration while it is.
        self.stop_periodic_measurement()
        self._send(_REINITIALIZE, is_refusal_tolerated=True)

    def _apply_configuration(self) -> None:
        if self._offset_c is not None:
            self._send(_SET_TEMPERATURE_OFFSET, argument=encode_temperature_offset(self._offset_c))
        if self._altitude_m is not None:
            self._send(_SET_ALTITUDE, argument=self._altitude_m)
        self._send(_SET_ASC, argument=1 if self._asc_enabled else 0)

    def _read_back_configuration(self) -> None:
        self.applied_offset_c = decode_temperature_offset(
            self._read_words(_GET_TEMPERATURE_OFFSET, 1)[0]
        )
        self.applied_asc = bool(self._read_words(_GET_ASC, 1)[0])

    def _is_data_ready(self) -> bool:
        return bool(self._read_words(_GET_DATA_READY, 1)[0] & _DATA_READY_MASK)

    def _judge_co2_word(self, co2_word: int) -> Measurement:
        co2 = judge_co2(co2_word, self._co2_min_ppm, self._co2_max_ppm)
        # Only a credible value reaches the rate guard, so a refused one cannot become its baseline.
        if not co2.valid or self._rate_guard is None:
            return co2
        is_plausible, reason = self._rate_guard.judge(co2.value, self._monotonic())
        return co2 if is_plausible else invalid(UNIT_PPM, reason or "RATE_IMPLAUSIBLE")

    def _describe_asc(self) -> str:
        if self.applied_asc is None:
            return "?"
        return "ON" if self.applied_asc else "off"

    def _send(
        self, command: int, argument: int | None = None, is_refusal_tolerated: bool = False
    ) -> None:
        from smbus2 import i2c_msg

        frame = split_word(command)
        if argument is not None:
            argument_bytes = split_word(argument)
            frame += argument_bytes + [crc8(argument_bytes)]
        try:
            self._bus.i2c_rdwr(i2c_msg.write(self._address, frame))
        except OSError:
            if not is_refusal_tolerated:
                raise
        execution_time_ms = _EXECUTION_TIME_MS.get(command, _DEFAULT_EXECUTION_TIME_MS)
        time.sleep(execution_time_ms / MILLISECONDS_PER_SECOND)

    def _read_words(self, command: int, word_count: int, argument: int | None = None) -> list[int]:
        from smbus2 import i2c_msg

        self._send(command, argument=argument)
        read_message = i2c_msg.read(self._address, word_count * _BYTES_PER_WORD_WITH_CRC)
        self._bus.i2c_rdwr(read_message)
        return decode_words(list(read_message))


SIMULATED_BURNER_PIN = 16
SIMULATED_FAN_PIN = 20
SIMULATED_START_MINUTES = 360
MINUTES_PER_DAY = 24 * 60
# The relays are active-LOW, so 0 means energised.
ENERGISED_LEVEL = 0


class SimulatedSensor:
    """A closed loop: the simulated relays push temperature and CO2, so rules are observable."""

    _INITIAL_TEMPERATURE_C = 18.0
    _INITIAL_CO2_PPM = 600.0
    _INITIAL_HUMIDITY_PCT = 55.0
    _DIURNAL_MEAN_C = 18
    _DIURNAL_AMPLITUDE_C = 7
    _DIURNAL_PHASE_MINUTES = 300
    _TEMPERATURE_PULL = 0.05
    _BURNER_HEATING_C = 0.25
    _FAN_COOLING_C = 0.4
    _CO2_DECAY_PPM = -8
    _BURNER_CO2_PPM = 45
    _FAN_CO2_PPM = 30
    _CO2_RANGE_PPM = (400.0, 2500.0)
    _HUMIDITY_RANGE_PCT = (20.0, 95.0)
    _FAN_DRYING_PCT = -0.5
    _IDLE_HUMIDIFYING_PCT = 0.2

    def __init__(
        self,
        gpio=None,
        burner_pin: int = SIMULATED_BURNER_PIN,
        fan_pin: int = SIMULATED_FAN_PIN,
        start_minutes: int = SIMULATED_START_MINUTES,
    ):
        self._gpio = gpio
        self._burner_pin = burner_pin
        self._fan_pin = fan_pin
        self._minutes = start_minutes
        self._temperature = self._INITIAL_TEMPERATURE_C
        self._co2 = self._INITIAL_CO2_PPM
        self._humidity = self._INITIAL_HUMIDITY_PCT

    def start(self) -> None:
        return None

    def read(self) -> Reading:
        is_burner_on = self._is_line_energised(self._burner_pin)
        is_fan_on = self._is_line_energised(self._fan_pin)
        self._minutes = (self._minutes + 1) % MINUTES_PER_DAY
        self._advance_temperature(is_burner_on, is_fan_on)
        self._advance_co2(is_burner_on, is_fan_on)
        self._advance_humidity(is_fan_on)
        return Reading(
            co2_ppm=Measurement(round(self._co2), True, UNIT_PPM),
            temperature_c=Measurement(self._temperature, True, UNIT_CELSIUS),
            humidity_pct=Measurement(round(self._humidity, 1), True, UNIT_PERCENT),
        )

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        return "simulated scd4x (closed loop)"

    def _advance_temperature(self, is_burner_on: bool, is_fan_on: bool) -> None:
        day_fraction = (self._minutes - self._DIURNAL_PHASE_MINUTES) / MINUTES_PER_DAY
        diurnal = self._DIURNAL_MEAN_C + self._DIURNAL_AMPLITUDE_C * math.sin(
            day_fraction * 2 * math.pi
        )
        change = (
            (diurnal - self._temperature) * self._TEMPERATURE_PULL
            + (self._BURNER_HEATING_C if is_burner_on else 0)
            - (self._FAN_COOLING_C if is_fan_on else 0)
        )
        self._temperature = round(self._temperature + change, 2)

    def _advance_co2(self, is_burner_on: bool, is_fan_on: bool) -> None:
        change = (
            self._CO2_DECAY_PPM
            + (self._BURNER_CO2_PPM if is_burner_on else 0)
            - (self._FAN_CO2_PPM if is_fan_on else 0)
        )
        self._co2 = _clamp(self._co2 + change, self._CO2_RANGE_PPM)

    def _advance_humidity(self, is_fan_on: bool) -> None:
        change = self._FAN_DRYING_PCT if is_fan_on else self._IDLE_HUMIDIFYING_PCT
        self._humidity = _clamp(self._humidity + change, self._HUMIDITY_RANGE_PCT)

    def _is_line_energised(self, pin: int) -> bool:
        return self._gpio is not None and self._gpio.level(pin) == ENERGISED_LEVEL


def _clamp(value: float, bounds: tuple[float, float]) -> float:
    lowest, highest = bounds
    return max(lowest, min(highest, value))


class WorldSensor:
    """Reads one position in the shared greenhouse; entrance and canopy differ by ~143 ppm."""

    def __init__(self, client, position: str, offset_c: float | None = None) -> None:
        self._client = client
        self._position = position
        # Applied agent-side because on real hardware the offset lives in the sensor, not the air.
        self._offset_c = offset_c

    def start(self) -> None:
        return None

    def read(self) -> Reading | None:
        try:
            site = self._client.read_site(self._position)
        except WorldUnreachable as error:
            return _unreachable_reading(error)

        temperature_c = float(site["temperature_c"])
        if self._offset_c is not None:
            temperature_c -= self._offset_c
        return Reading(
            co2_ppm=Measurement(value=float(site["co2_ppm"]), valid=True, unit=UNIT_PPM),
            temperature_c=Measurement(value=round(temperature_c, 2), valid=True, unit=UNIT_CELSIUS),
            humidity_pct=Measurement(
                value=float(site["humidity_pct"]), valid=True, unit=UNIT_PERCENT
            ),
        )

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        return f"world sensor at {self._position}"


def _unreachable_reading(error: WorldUnreachable) -> Reading:
    return Reading(
        co2_ppm=invalid(UNIT_PPM, f"world unreachable: {error}"),
        temperature_c=invalid(UNIT_CELSIUS, "world unreachable"),
        humidity_pct=invalid(UNIT_PERCENT, "world unreachable"),
    )
