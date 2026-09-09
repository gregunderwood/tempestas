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
