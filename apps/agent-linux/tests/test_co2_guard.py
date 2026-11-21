"""The guard between a dying sensor and a propane burner.

Every case here is a real word the SCD41 on elantris emitted on 2026-09-12
while failing, or a boundary next to one.
"""

from __future__ import annotations

import pytest

from tempestas_agent.sensor import judge_co2

LO, HI = 300, 5000


def test_a_normal_greenhouse_reading_is_a_measurement() -> None:
    m = judge_co2(1450, LO, HI)
    assert m.valid is True
    assert m.value == 1450.0
    assert m.unit == "ppm"


def test_zero_is_no_answer_not_zero_ppm() -> None:
    # The SCD4x reports 0 when it has nothing. Passing that on as 0 ppm reads as
    # "extremely low", which is the one direction that lights the burner.
    m = judge_co2(0, LO, HI)
    assert m.valid is False
    assert m.value is None
    assert m.reason == "ZERO_READING"


def test_a_reading_somewhat_below_outdoor_is_KEPT() -> None:
    # The floor is 300, not outdoor air. A crop in a closed house genuinely
    # depletes below 400, and a sensor drifting low should read inaccurately
    # rather than fall silent: on 2026-09-14 elantris converged on exactly 400
    # and everything beneath vanished, which made a miscalibrated sensor
    # impossible to tell from a dead one.
    assert judge_co2(350, LO, HI).valid is True
    assert judge_co2(399, LO, HI).valid is True


def test_an_impossibly_low_reading_is_still_refused() -> None:
    # 293 ppm, observed while failing. No mechanism here produces that, and low
    # is the direction that calls for CO2.
    m = judge_co2(293, LO, HI)
    assert m.valid is False
    assert "BELOW_RANGE" in (m.reason or "")
    assert judge_co2(196, LO, HI).valid is False   # the worst seen


def test_above_the_sensors_own_ceiling_is_refused() -> None:
    # 15,723 ppm, observed - three times the SCD41's specified ceiling. The old
    # guard was `0 < raw < 40000` and stored this as a genuine measurement.
    m = judge_co2(15723, LO, HI)
    assert m.valid is False
    assert "ABOVE_RANGE" in (m.reason or "")


@pytest.mark.parametrize("raw", [5789, 6295, 8208, 13219, 14990])
def test_every_bad_value_observed_that_day_is_refused(raw: int) -> None:
    assert judge_co2(raw, LO, HI).valid is False


def test_the_bounds_themselves_are_accepted() -> None:
    # Inclusive: 400 ppm is outdoor air and 5000 is the top of spec. Neither is
    # a fault, and excluding them would reject real readings at the edges.
    assert judge_co2(LO, LO, HI).valid is True
    assert judge_co2(HI, LO, HI).valid is True
    assert judge_co2(LO - 1, LO, HI).valid is False
    assert judge_co2(HI + 1, LO, HI).valid is False


def test_a_sealed_house_can_lower_its_floor() -> None:
    # Depletion below 400 is real in a SEALED greenhouse with a heavy crop -
    # it is the reason to enrich at all. That deployment lowers the bound
    # rather than losing the guard.
    assert judge_co2(280, LO, HI).valid is False
    assert judge_co2(280, 200, HI).valid is True


def test_the_old_guard_would_have_passed_all_of_these() -> None:
    # The regression, stated directly: every one of these satisfied the previous
    # condition and reached the rules engine as a number.
    for raw in (293, 5789, 13219, 15723):
        assert 0 < raw < 40000, "these all passed the old guard"
        assert judge_co2(raw, LO, HI).valid is False, "and none pass the new one"
