"""The sandbox backends must be no more forgiving than the hardware ones."""

from __future__ import annotations

import pytest

from tempestas_agent.gpio import GpioUnavailable, WorldGpio
from tempestas_agent.sensor import WorldSensor
from tempestas_agent.world_client import WorldUnreachable


class FakeClient:
    def __init__(self, site=None, is_failing=False):
        self.site = site or {"co2_ppm": 1200.0, "temperature_c": 24.0, "humidity_pct": 55.0}
        self.is_failing = is_failing
        self.writes: list[tuple[str, int, int]] = []

    def read_site(self, position):
        if self.is_failing:
            raise WorldUnreachable("down")
        return dict(self.site, position=position)

    def set_level(self, node_id, pin, level):
        if self.is_failing:
            raise WorldUnreachable("down")
        self.writes.append((node_id, pin, level))


def test_claim_pushes_the_failsafe_level_to_the_world() -> None:
    # Real hardware claims at the failsafe level, so the world has to start there too.
    client = FakeClient()
    gpio = WorldGpio("greenhouse", client)
    gpio.claim((21, 26), {21: 1, 26: 0})

    assert ("greenhouse", 21, 1) in client.writes
    assert ("greenhouse", 26, 0) in client.writes, "BCM 26 is active-HIGH; its OFF is 0"


def test_an_unmanaged_pin_is_refused_before_it_reaches_the_world() -> None:
    client = FakeClient()
    gpio = WorldGpio("elantris", client)
    gpio.claim((5,), {5: 1})
    client.writes.clear()

    with pytest.raises(GpioUnavailable):
        gpio.write(6, 0)
    assert client.writes == [], "a refused pin must not reach the world either"


def test_a_bad_level_is_refused() -> None:
    gpio = WorldGpio("elantris", FakeClient())
    gpio.claim((5,), {5: 1})
    with pytest.raises(ValueError):
        gpio.write(5, 2)


def test_an_unreachable_world_fails_the_write_rather_than_lying() -> None:
    client = FakeClient()
    gpio = WorldGpio("elantris", client)
    gpio.claim((5,), {5: 1})
    client.is_failing = True

    with pytest.raises(GpioUnavailable):
        gpio.write(5, 0)


def test_failsafe_never_raises_even_when_the_world_is_gone() -> None:
    client = FakeClient()
    gpio = WorldGpio("elantris", client)
    gpio.claim((5,), {5: 1})
    gpio.write(5, 0)
    client.is_failing = True

    gpio.failsafe()  # must not raise
    gpio.close()  # must not raise
    assert gpio.level(5) == 1, "local state still went safe"


def test_sensor_reports_invalid_rather_than_inventing_a_reading() -> None:
    sensor = WorldSensor(FakeClient(is_failing=True), "canopy")
    reading = sensor.read()

    assert reading is not None
    assert reading.co2_ppm.valid is False
    assert reading.co2_ppm.value is None
    assert "unreachable" in (reading.co2_ppm.reason or "")


def test_sensor_applies_its_offset_like_the_real_one() -> None:
    client = FakeClient(site={"co2_ppm": 900.0, "temperature_c": 24.0, "humidity_pct": 50.0})
    assert WorldSensor(client, "canopy").read().temperature_c.value == 24.0
    assert WorldSensor(client, "canopy", offset_c=4.0).read().temperature_c.value == 20.0


def test_position_is_carried_through() -> None:
    client = FakeClient()
    assert "canopy" in WorldSensor(client, "canopy").describe()
