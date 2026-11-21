"""The SCD4x decode path, which is where a wrong number becomes a wrong decision."""

from __future__ import annotations

import sys
import types

import pytest

from tempestas_agent.gpio import SimulatedGpio
from tempestas_agent.sensor import (
    Scd4xSensor,
    SimulatedSensor,
    convert_humidity,
    convert_temperature,
    crc8,
    decode_words,
    encode_temperature_offset,
)

# Command words from the datasheet, written out so a typo in the driver's table would show.
STOP_PERIODIC = 0x3F86
START_PERIODIC = 0x21B1
GET_SERIAL = 0x3682
GET_TEMPERATURE_OFFSET = 0x2318
SET_TEMPERATURE_OFFSET = 0x241D
SET_ALTITUDE = 0x2427
# The 4.00 C factory default offset.
FACTORY_OFFSET_WORD = 0x05DA


def test_crc8_matches_the_datasheet_example():
    assert crc8([0xBE, 0xEF]) == 0x92


def test_decode_words_verifies_every_crc():
    good = [0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x92]
    assert decode_words(good) == [0xBEEF, 0xBEEF]


# Flaky I2C is the normal failure on a long STEMMA cable; a corrupted word must raise.
def test_decode_words_raises_on_a_bad_crc():
    with pytest.raises(OSError, match="CRC mismatch"):
        decode_words([0xBE, 0xEF, 0x00])


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(0, -45.0), (65535, 130.0), (32768, 42.5)],
)
def test_temperature_conversion(raw, expected):
    assert convert_temperature(raw) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize(("raw", "expected"), [(0, 0.0), (65535, 100.0), (32768, 50.0)])
def test_humidity_conversion(raw, expected):
    assert convert_humidity(raw) == pytest.approx(expected, abs=0.01)


class TestSimulatedSensor:
    def test_produces_a_plausible_reading(self):
        reading = SimulatedSensor().read()
        assert reading.temperature_c.valid
        assert 0 < reading.co2_ppm.value < 5000

    # The closed loop is what makes "burner on -> CO2 climbs" observable with no hardware.
    def test_co2_climbs_while_the_burner_line_is_energised(self):
        gpio = SimulatedGpio()
        gpio.claim((16, 20), {16: 1, 20: 1})
        sensor = SimulatedSensor(gpio=gpio)

        before = sensor.read().co2_ppm.value
        gpio.write(16, 0)  # active-LOW: 0 energises
        for _sample_number in range(5):
            after = sensor.read().co2_ppm.value
        assert after > before


class FakeBus:
    """Records the command words written, so the startup ORDER can be asserted."""

    def __init__(self, replies: dict[int, list[int]] | None = None):
        self.commands: list[int] = []
        self._replies = replies or {}
        self._pending: list[int] = []
        self.closed = False

    def i2c_rdwr(self, message):
        if getattr(message, "is_read", False):
            message.words = self._pending
            return
        command = (message.frame[0] << 8) | message.frame[1]
        self.commands.append(command)
        self._pending = self._replies.get(command, [0x0000])

    def close(self):
        self.closed = True


class FakeWriteMessage:
    is_read = False

    def __init__(self, frame):
        self.frame = frame


class FakeReadMessage:
    is_read = True

    def __init__(self, length):
        self.length = length
        self.words: list[int] = []

    def __iter__(self):
        for word in self.words:
            high_byte, low_byte = (word >> 8) & 0xFF, word & 0xFF
            yield from (high_byte, low_byte, crc8([high_byte, low_byte]))


def install_fake_bus(monkeypatch, bus: FakeBus):
    """Stand in for smbus2, which is not importable in a meaningful way here."""
    fake_smbus2 = types.SimpleNamespace(
        SMBus=lambda _bus_number: bus,
        i2c_msg=types.SimpleNamespace(
            write=lambda _address, frame: FakeWriteMessage(frame),
            read=lambda _address, length: FakeReadMessage(length),
        ),
    )
    monkeypatch.setitem(sys.modules, "smbus2", fake_smbus2)


# The SCD4x NACKs every configuration command once measuring, so all of it happens before.
class TestScd4xStartupOrder:
    def test_configures_and_reads_back_before_measurement_starts(self, monkeypatch):
        bus = FakeBus(
            replies={
                GET_SERIAL: [0x5FD9, 0x0B07, 0x3B7A],
                GET_TEMPERATURE_OFFSET: [FACTORY_OFFSET_WORD],
            }
        )
        install_fake_bus(monkeypatch, bus)

        sensor = Scd4xSensor(bus=1, address=0x62, offset_c=6.0, altitude_m=600)
        sensor.start()

        start_periodic = bus.commands.index(START_PERIODIC)
        for name, command in [
            ("stop_periodic", STOP_PERIODIC),
            ("set_temperature_offset", SET_TEMPERATURE_OFFSET),
            ("set_altitude", SET_ALTITUDE),
            ("get_temperature_offset", GET_TEMPERATURE_OFFSET),
        ]:
            assert bus.commands.index(command) < start_periodic, f"{name} must precede measurement"

        assert sensor.serial == "5fd90b073b7a"
        assert sensor.applied_offset_c == pytest.approx(4.0, abs=0.01)

    # Never trusted to persist: the old system's driver never called persist_settings.
    def test_writes_the_offset_even_though_it_may_already_be_set(self, monkeypatch):
        bus = FakeBus(
            replies={
                GET_SERIAL: [0x0001, 0x0002, 0x0003],
                GET_TEMPERATURE_OFFSET: [FACTORY_OFFSET_WORD],
            }
        )
        install_fake_bus(monkeypatch, bus)

        Scd4xSensor(bus=1, address=0x62, offset_c=6.0, altitude_m=None).start()
        assert SET_TEMPERATURE_OFFSET in bus.commands

    def test_no_offset_configured_means_no_write(self, monkeypatch):
        bus = FakeBus(replies={GET_SERIAL: [0x0001, 0x0002, 0x0003], GET_TEMPERATURE_OFFSET: [0]})
        install_fake_bus(monkeypatch, bus)

        Scd4xSensor(bus=1, address=0x62, offset_c=None, altitude_m=None).start()
        assert SET_TEMPERATURE_OFFSET not in bus.commands

    def test_offset_encoding_matches_the_datasheet_scaling(self):
        assert encode_temperature_offset(4.0) == FACTORY_OFFSET_WORD
        assert encode_temperature_offset(6.0) == round(6.0 * 65535 / 175)
