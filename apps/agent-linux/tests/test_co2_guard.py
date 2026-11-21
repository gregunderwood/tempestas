"""The guard between a dying sensor and a burner, using words elantris emitted on 2026-09-12."""

from __future__ import annotations

import pytest

from tempestas_agent.sensor import judge_co2

FLOOR_PPM, CEILING_PPM = 300, 5000
OLD_GUARD_CEILING = 40000


def test_a_normal_greenhouse_reading_is_a_measurement() -> None:
    measurement = judge_co2(1450, FLOOR_PPM, CEILING_PPM)
    assert measurement.valid is True
    assert measurement.value == 1450.0
    assert measurement.unit == "ppm"


def test_zero_is_no_answer_not_zero_ppm() -> None:
    # Passed on as 0 ppm it would read as extremely low, the direction that lights the burner.
    measurement = judge_co2(0, FLOOR_PPM, CEILING_PPM)
    assert measurement.valid is False
    assert measurement.value is None
    assert measurement.reason == "ZERO_READING"


def test_a_reading_somewhat_below_outdoor_is_KEPT() -> None:
    # A sensor drifting low should read inaccurately rather than fall silent.
    assert judge_co2(350, FLOOR_PPM, CEILING_PPM).valid is True
    assert judge_co2(399, FLOOR_PPM, CEILING_PPM).valid is True


def test_an_impossibly_low_reading_is_still_refused() -> None:
    measurement = judge_co2(293, FLOOR_PPM, CEILING_PPM)
    assert measurement.valid is False
    assert "BELOW_RANGE" in (measurement.reason or "")
    assert judge_co2(196, FLOOR_PPM, CEILING_PPM).valid is False  # the worst seen


def test_above_the_sensors_own_ceiling_is_refused() -> None:
    measurement = judge_co2(15723, FLOOR_PPM, CEILING_PPM)
    assert measurement.valid is False
    assert "ABOVE_RANGE" in (measurement.reason or "")


@pytest.mark.parametrize("raw", [5789, 6295, 8208, 13219, 14990])
def test_every_bad_value_observed_that_day_is_refused(raw: int) -> None:
    assert judge_co2(raw, FLOOR_PPM, CEILING_PPM).valid is False


def test_the_bounds_themselves_are_accepted() -> None:
    assert judge_co2(FLOOR_PPM, FLOOR_PPM, CEILING_PPM).valid is True
    assert judge_co2(CEILING_PPM, FLOOR_PPM, CEILING_PPM).valid is True
    assert judge_co2(FLOOR_PPM - 1, FLOOR_PPM, CEILING_PPM).valid is False
    assert judge_co2(CEILING_PPM + 1, FLOOR_PPM, CEILING_PPM).valid is False


def test_a_sealed_house_can_lower_its_floor() -> None:
    assert judge_co2(280, FLOOR_PPM, CEILING_PPM).valid is False
    assert judge_co2(280, 200, CEILING_PPM).valid is True


def test_the_old_guard_would_have_passed_all_of_these() -> None:
    for raw in (293, 5789, 13219, 15723):
        assert 0 < raw < OLD_GUARD_CEILING, "these all passed the old guard"
        assert judge_co2(raw, FLOOR_PPM, CEILING_PPM).valid is False, "and none pass the new one"
