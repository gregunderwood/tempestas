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
_PERFORM_FRC = 0x362F
_SET_ASC = 0x2416
_GET_ASC = 0x2313
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


def judge_co2(raw: int, lo: int, hi: int) -> Measurement:
    """Is this word a measurement, or the sensor failing to have an answer?

    The guard used to be `0 < raw < 40000` - the chip's whole output width - and
    a dying SCD41 walked straight through it. Observed on elantris on
    2026-09-12: 293 ppm (below outdoor air) and 15,723 ppm (three times the
    sensor's own ceiling), both stored as genuine measurements.

    Low readings are the dangerous direction. The rules engine resolves
    `node:<slug>` to a SINGLE sample with no averaging, so one spurious 293 ppm
    is a command to light a propane burner. A rejected reading is merely absent,
    and Safety rule 4 turns absent into +Infinity, which keeps it off.

    The bounds are config, not constants, because they are a statement about
    this greenhouse as much as about the chip. The floor is 300 rather than
    outdoor air: a crop in a closed house genuinely depletes below 400, and a
    sensor drifting low should read inaccurately rather than fall silent - on
    2026-09-14 elantris converged on exactly 400 and everything beneath it
    vanished, which made a miscalibrated sensor indistinguishable from a dead
    one. Below 300 is refused, because no mechanism here produces that and low
    is the direction that calls for CO2.
    """
    if raw == 0:
        # The SCD4x's own way of saying it has no answer. Not 0 ppm.
        return invalid("ppm", "ZERO_READING")
    if raw < lo:
        return invalid("ppm", f"BELOW_RANGE ({raw} < {lo})")
    if raw > hi:
        return invalid("ppm", f"ABOVE_RANGE ({raw} > {hi})")
    return Measurement(float(raw), True, "ppm")


class RateGuard:
    """Refuse readings that arrive faster than the greenhouse can actually move.

    The range guard catches impossible VALUES. This catches impossible
    CHANGES, which is the failure the range guard cannot see: on 2026-09-13 the
    sensor emitted jumps of 154, 184 and 489 ppm between consecutive 10-second
    samples. Every one of those was inside 400-5000 and sailed through, while
    being physically impossible - the worst was 2933 ppm/min.

    The threshold is calibrated against a KNOWN-GOOD day, not against theory.
    100 ppm/min is the fastest the greenhouse has genuinely moved, but that is a
    net rate over minutes; per-sample rates carry the sensor's quantisation
    noise over a 10-second window and routinely reach 285 ppm/min (p99) on a
    healthy sensor, peaking at 390. A 200 ppm/min limit therefore refused 2.8%
    of a clean day - MORE than it refused of a degraded one. 400 separates them:
    nothing on the clean day, 1.1% on the degraded one.

    Three cases have to be handled or the guard is worse than nothing:

    - **A gap.** After a restart or a stretch of refusals there is no basis for
      comparison, so accept and re-baseline rather than reject on a stale
      reference.
    - **A genuine step.** Forced recalibration moves the whole scale at once,
      and a guard that never re-baselines would reject everything afterwards
      forever. So after `resync_after` consecutive refusals it re-baselines -
      but only on CORROBORATION. Accepting the next reading unconditionally is
      what let 3647 ppm through on 2026-09-15 while the sensor was spewing: a
      failing sensor produces refusals just as persistently as a real step does.
      A genuine step settles at a new level, so the candidate must be confirmed
      by a following reading close to it before either is believed.
    - **Never re-baseline on a refusal.** A spike must not become the reference
      the next reading is judged against, or one bad sample drags the guard
      along behind it.
    """

    def __init__(
        self,
        max_ppm_per_min: float = 400.0,
        max_gap_s: float = 120.0,
        resync_after: int = 3,
        corroborate_within_ppm: float = 60.0,
    ) -> None:
        self.max_ppm_per_min = max_ppm_per_min
        self.max_gap_s = max_gap_s
        self.resync_after = resync_after
        # How close a confirming reading must be for a candidate step to be
        # believed. Wide enough for a real setpoint move plus normal noise,
        # far tighter than the scatter a failing sensor produces.
        self.corroborate_within_ppm = corroborate_within_ppm
        self._prev: tuple[float, float] | None = None  # (value, monotonic seconds)
        self._rejected = 0
        self._candidate: float | None = None

    def judge(self, value: float, at: float) -> tuple[bool, str | None]:
        prev = self._prev
        if prev is None:
            self._prev = (value, at)
            return True, None

        dt = at - prev[1]
        if dt <= 0 or dt > self.max_gap_s:
            # No usable reference. Accepting is the safe choice: the range
            # guard still applies, and refusing here would blank the sensor
            # after every restart.
            self._prev = (value, at)
            self._rejected = 0
            return True, None

        rate = abs(value - prev[0]) / (dt / 60.0)
        if rate <= self.max_ppm_per_min:
            self._prev = (value, at)
            self._rejected = 0
            return True, None

        self._rejected += 1
        if self._rejected >= self.resync_after:
            # Persistent refusals mean EITHER the scale moved or the sensor is
            # spewing, and those need opposite responses. Wait for corroboration
            # to tell them apart: a real step settles, garbage scatters.
            if (
                self._candidate is not None
                and abs(value - self._candidate) <= self.corroborate_within_ppm
            ):
                self._prev = (value, at)
                self._rejected = 0
                self._candidate = None
                return True, None
            self._candidate = value
            return False, (
                f"RATE_IMPLAUSIBLE ({rate:.0f} ppm/min > {self.max_ppm_per_min:.0f}), "
                f"awaiting corroboration"
            )
        return False, f"RATE_IMPLAUSIBLE ({rate:.0f} ppm/min > {self.max_ppm_per_min:.0f})"


class Scd4xSensor:
    """Raw I2C SCD4x. One sensor per bus address; all SCD4x share 0x62."""

    def __init__(
        self,
        bus: int,
        address: int,
        offset_c: float | None,
        altitude_m: int | None,
        co2_min: int = 300,
        co2_max: int = 5000,
        asc_enabled: bool = False,
        max_ppm_per_min: float = 400.0,
        monotonic=None,
    ):
        self._bus_no = bus
        self._addr = address
        self._offset_c = offset_c
        self._co2_min = co2_min
        self._co2_max = co2_max
        self._asc_enabled = asc_enabled
        self.applied_asc: bool | None = None
        import time as _time

        self._monotonic = monotonic or _time.monotonic
        # Zero disables it, for a deployment that genuinely changes faster than
        # this greenhouse can.
        self._rate_guard = RateGuard(max_ppm_per_min) if max_ppm_per_min > 0 else None
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

        # Automatic Self-Calibration, set every startup for the same reason the
        # offset is.
        #
        # ASC assumes the space returns to ~400 ppm outdoor air regularly and
        # treats the lowest reading it has seen over about a week as that
        # baseline. An ENRICHED greenhouse never returns there, so ASC keeps
        # revising the baseline down toward a number the air never reaches, and
        # the sensor reads progressively low - with no error, no flag, and
        # nothing downstream able to tell. A sensor reading low is the direction
        # that calls for more CO2.
        #
        # It ships from Sensirion ENABLED, and nothing here touched it before,
        # so every reading this system has taken was on a sensor quietly
        # recalibrating itself against an assumption that does not hold.
        self._send(_SET_ASC, arg=1 if self._asc_enabled else 0)

        # Read the offset back BEFORE measurement starts: this is the only
        # window the chip will answer in, and an offset that silently failed to
        # apply is exactly the failure this re-applying exists to catch.
        self.applied_offset_c = round(175 * self._read_words(_GET_TEMP_OFFSET, 1)[0] / 65535, 2)
        self.applied_asc = bool(self._read_words(_GET_ASC, 1)[0])

        self._send(_START_PERIODIC)

    def read(self) -> Reading | None:
        if not (self._read_words(_GET_DATA_READY, 1)[0] & _DATA_READY_MASK):
            return None
        co2_raw, t_raw, rh_raw = self._read_words(_READ_MEASUREMENT, 3)

        co2 = judge_co2(co2_raw, self._co2_min, self._co2_max)
        # Only rate-check a value that is otherwise credible. Feeding a rejected
        # one to the guard would let it poison the baseline.
        if co2.valid and self._rate_guard is not None:
            ok, reason = self._rate_guard.judge(co2.value, self._monotonic())
            if not ok:
                co2 = invalid("ppm", reason or "RATE_IMPLAUSIBLE")

        return Reading(
            co2_ppm=co2,
            temperature_c=Measurement(round(convert_temperature(t_raw), 2), True, "C"),
            humidity_pct=Measurement(round(convert_humidity(rh_raw), 1), True, "%"),
        )

    def self_test(self) -> int:
        """0x0000 is a pass. Takes about 10 seconds."""
        return self._read_words(_SELF_TEST, 1, exec_ms=10_000)[0]

    def forced_recalibration(self, target_ppm: int) -> int:
        """Tell the sensor what it SHOULD be reading, and return the correction.

        The repair for a baseline that has gone wrong. ASC assumes the lowest
        reading of its window is fresh air at 400 ppm; on elantris a failing
        sensor emitted a cluster of spurious lows around 300 ppm, ASC took those
        for fresh air, and everything afterwards read about 115 ppm high.
        Disabling ASC stops that drifting further but FREEZES the bad
        correction - only an FRC undoes it.

        Requirements the datasheet is strict about, because a bad FRC is worse
        than the drift it repairs:

        - The sensor must have been in periodic measurement for **at least 3
          minutes** in the reference environment. The caller enforces this;
          this method cannot tell how long it has been sitting there.
        - Measurement must be STOPPED before the command. The chip rejects
          configuration while sampling.

        Returns the applied correction in ppm - a number worth logging, because
        it says how far out the sensor was, and a large one is a reason to
        distrust the sensor rather than to celebrate the fix.
        """
        self._send(_STOP_PERIODIC, exec_ms=500, tolerate=True)
        raw = self._read_words(_PERFORM_FRC, 1, exec_ms=400, arg=target_ppm)[0]
        self._send(_START_PERIODIC)
        if raw == 0xFFFF:
            raise OSError(
                "forced recalibration REJECTED by the sensor. The usual cause is "
                "too little time in the reference environment - it needs 3+ "
                "minutes of periodic measurement there first."
            )
        # The chip returns the correction offset by 0x8000 so it can express a
        # negative one in an unsigned word.
        return raw - 0x8000

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
        # ASC is in the startup line on purpose. It is invisible in the data -
        # a sensor drifting under ASC looks exactly like a greenhouse getting
        # leaner - so the log is the only place it can be caught.
        asc = "?" if self.applied_asc is None else ("ON" if self.applied_asc else "off")
        return (
            f"scd4x @ i2c-{self._bus_no}:0x{self._addr:02x} "
            f"serial={self.serial or 'unknown'} offset={offset} asc={asc}"
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

    def _read_words(
        self, cmd: int, nwords: int, exec_ms: int = 1, arg: int | None = None
    ) -> list[int]:
        from smbus2 import i2c_msg

        # `arg` is for the few commands that take a parameter AND answer -
        # forced recalibration is the only one today.
        self._send(cmd, arg=arg, exec_ms=exec_ms)
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


class WorldSensor:
    """Reads one position in the shared greenhouse.

    The position is the whole point. `entrance` and `canopy` are the same air
    but not the same measurement, and a rule tuned against the wrong one is
    wrong by ~143 ppm of CO2 - which is most of the dead band.
    """

    def __init__(self, client, position: str, offset_c: float | None = None) -> None:
        self._client = client
        self._position = position
        # Applied here rather than in the world, because on real hardware the
        # offset lives in the sensor. Modelling it agent-side keeps the
        # calibration path identical in the sandbox and in the greenhouse.
        self._offset_c = offset_c

    def start(self) -> None:
        return None

    def read(self) -> Reading | None:
        from .world_client import WorldUnreachable

        try:
            body = self._client.read_site(self._position)
        except WorldUnreachable as exc:
            # A sensor that cannot be reached has NO reading. Returning a
            # fabricated one is the failure mode Safety rule 4 exists for.
            return Reading(
                co2_ppm=invalid("ppm", f"world unreachable: {exc}"),
                temperature_c=invalid("C", "world unreachable"),
                humidity_pct=invalid("%", "world unreachable"),
            )

        temp = float(body["temperature_c"])
        if self._offset_c is not None:
            temp -= self._offset_c
        return Reading(
            co2_ppm=Measurement(value=float(body["co2_ppm"]), valid=True, unit="ppm"),
            temperature_c=Measurement(value=round(temp, 2), valid=True, unit="C"),
            humidity_pct=Measurement(value=float(body["humidity_pct"]), valid=True, unit="%"),
        )

    def stop(self) -> None:
        return None

    def describe(self) -> str:
        return f"world sensor at {self._position}"

