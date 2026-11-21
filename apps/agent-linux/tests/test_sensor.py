"""The SCD4x decode path, which is where a wrong number becomes a wrong decision."""

from __future__ import annotations

import pytest

from tempestas_agent.sensor import (
    SimulatedSensor,
    convert_humidity,
    convert_temperature,
    crc8,
    decode_words,
)


# Sensirion's datasheet worked example: 0xBEEF has CRC 0x92.
def test_crc8_matches_the_datasheet_example():
    assert crc8([0xBE, 0xEF]) == 0x92


def test_decode_words_verifies_every_crc():
    good = [0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x92]
    assert decode_words(good) == [0xBEEF, 0xBEEF]


# Flaky I2C is the normal failure on a long STEMMA cable. A corrupted word must
# raise, never be handed on as a reading.
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

    # The property the whole sim-mode story rests on: it is a closed loop, so
    # "burner on -> CO2 climbs" is observable with no hardware at all.
    def test_co2_climbs_while_the_burner_line_is_energised(self):
        from tempestas_agent.gpio import SimulatedGpio

        gpio = SimulatedGpio()
        gpio.claim((16, 20), {16: 1, 20: 1})
        sensor = SimulatedSensor(gpio=gpio)

        before = sensor.read().co2_ppm.value
        gpio.write(16, 0)  # active-LOW: 0 energises
        for _ in range(5):
            after = sensor.read().co2_ppm.value
        assert after > before


class FakeBus:
    """Records the command words written, so the startup ORDER can be asserted.

    The order is not cosmetic. The SCD4x NACKs every configuration command once
    periodic measurement is running - a Remote I/O error, not a subtly wrong
    answer - so anything that configures or reads back configuration has to
    happen inside the idle window at startup. This was found on real hardware.
    """

    def __init__(self, replies: dict[int, list[int]] | None = None):
        self.commands: list[int] = []
        self._replies = replies or {}
        self._pending: list[int] = []
        self.closed = False

    def i2c_rdwr(self, msg):
        if getattr(msg, "_is_read", False):
            msg.words = self._pending
            return
        cmd = (msg.data[0] << 8) | msg.data[1]
        self.commands.append(cmd)
        self._pending = self._replies.get(cmd, [0x0000])

    def close(self):
        self.closed = True


def _install_fake_bus(monkeypatch, bus: FakeBus):
    """Stand in for smbus2, which is not importable in a meaningful way here."""
    import types

    class _WriteMsg:
        _is_read = False

        def __init__(self, data):
            self.data = data

    class _ReadMsg:
        _is_read = True

        def __init__(self, length):
            self.length = length
            self.words: list[int] = []

        def __iter__(self):
            from tempestas_agent.sensor import crc8

            for word in self.words:
                hi, lo = (word >> 8) & 0xFF, word & 0xFF
                yield from (hi, lo, crc8([hi, lo]))

    fake = types.SimpleNamespace(
        SMBus=lambda _n: bus,
        i2c_msg=types.SimpleNamespace(
            write=lambda _addr, data: _WriteMsg(data),
            read=lambda _addr, length: _ReadMsg(length),
        ),
    )
    monkeypatch.setitem(__import__("sys").modules, "smbus2", fake)


class TestScd4xStartupOrder:
    def test_configures_and_reads_back_before_measurement_starts(self, monkeypatch):
        from tempestas_agent.sensor import Scd4xSensor

        bus = FakeBus(
            replies={
                0x3682: [0x5FD9, 0x0B07, 0x3B7A],  # serial
                0x2318: [0x05DA],  # the 4.00 C factory default
            }
        )
        _install_fake_bus(monkeypatch, bus)

        sensor = Scd4xSensor(bus=1, address=0x62, offset_c=6.0, altitude_m=600)
        sensor.start()

        start_periodic = bus.commands.index(0x21B1)
        for name, cmd in [
            ("stop_periodic", 0x3F86),
            ("set_temperature_offset", 0x241D),
            ("set_altitude", 0x2427),
            ("get_temperature_offset", 0x2318),
        ]:
            assert bus.commands.index(cmd) < start_periodic, f"{name} must precede measurement"

        assert sensor.serial == "5fd90b073b7a"
        assert sensor.applied_offset_c == pytest.approx(4.0, abs=0.01)

    # Applied at EVERY startup, never trusted to persist: the driver the old
    # system used never called persist_settings, so the value is lost to every
    # power cycle.
    def test_writes_the_offset_even_though_it_may_already_be_set(self, monkeypatch):
        from tempestas_agent.sensor import Scd4xSensor

        bus = FakeBus(replies={0x3682: [0x0001, 0x0002, 0x0003], 0x2318: [0x05DA]})
        _install_fake_bus(monkeypatch, bus)

        Scd4xSensor(bus=1, address=0x62, offset_c=6.0, altitude_m=None).start()
        assert 0x241D in bus.commands

    def test_no_offset_configured_means_no_write(self, monkeypatch):
        from tempestas_agent.sensor import Scd4xSensor

        bus = FakeBus(replies={0x3682: [0x0001, 0x0002, 0x0003], 0x2318: [0x0000]})
        _install_fake_bus(monkeypatch, bus)

        Scd4xSensor(bus=1, address=0x62, offset_c=None, altitude_m=None).start()
        assert 0x241D not in bus.commands

    def test_offset_encoding_matches_the_datasheet_scaling(self):
        from tempestas_agent.sensor import Scd4xSensor

        # 4 C is the SCD4x factory default and encodes to 0x05DA.
        assert Scd4xSensor._encode_offset(4.0) == 0x05DA
        assert Scd4xSensor._encode_offset(6.0) == round(6.0 * 65535 / 175)
