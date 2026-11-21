"""The simulator is only worth having if it reproduces the greenhouse we measured."""

from __future__ import annotations

from pathlib import Path

import pytest

from tempestas_sim.world import (
    MINUTES_PER_DAY,
    ROLE_CO2,
    ROLE_FAN,
    ROLE_HPS,
    ROLE_MH,
    ROLE_NONE,
    Air,
    Fixture,
    Model,
    World,
    saturation_pressure,
)

MODEL_PATH = Path(__file__).resolve().parents[1] / "greenhouse-model.json"
EVENING_START_MINUTE = 17 * 60

BURNER = ("elantris", 5)
BURNER_ON_LEVEL = 0
BURNER_OFF_LEVEL = 1

# Mixed polarity on purpose: four active-LOW channels and one active-HIGH module.
WIRING = [
    Fixture("elantris", 5, ROLE_CO2, on_level=0),
    Fixture("greenhouse", 21, ROLE_HPS, on_level=0),
    Fixture("greenhouse", 20, ROLE_FAN, on_level=0),
    Fixture("greenhouse", 26, ROLE_MH, on_level=1),
    Fixture("greenhouse", 16, ROLE_NONE, on_level=0),
    Fixture("greenhouse", 12, ROLE_NONE, on_level=0),
]


@pytest.fixture
def model() -> Model:
    return Model.load(MODEL_PATH)


@pytest.fixture
def world(model: Model) -> World:
    return World(model, WIRING, air=Air(co2_ppm=1400.0, temp_c=23.0, vapour_hpa=16.0))


def test_polarity_is_per_fixture_not_per_board(world: World) -> None:
    for node, pin in [("greenhouse", 21), ("greenhouse", 20), ("greenhouse", 26)]:
        world.set_level(node, pin, 0)

    assert world.energised(ROLE_HPS) is True
    assert world.energised(ROLE_FAN) is True
    assert world.energised(ROLE_MH) is False, "BCM 26 is active-HIGH; LOW is off"

    world.set_level("greenhouse", 26, 1)
    assert world.energised(ROLE_MH) is True


def test_a_line_nobody_wrote_is_unknown_not_off(world: World) -> None:
    assert world.levels[("elantris", 5)] is None
    assert world.energised(ROLE_CO2) is False


def test_dark_and_spare_channels_drive_nothing(world: World) -> None:
    before = world.read("canopy")
    for pin in (16, 12):
        world.set_level("greenhouse", pin, 0)
    world.step(minutes=10, minute_of_day=600)
    after = world.read("canopy")
    assert after.co2_ppm < before.co2_ppm, "CO2 should just be leaking away"


def test_the_burner_arrives_at_the_sensor_gradually(world: World) -> None:
    world.set_level("elantris", 5, 0)

    before = world.air.co2_ppm
    world.step(minutes=1, minute_of_day=600)
    first_minute = world.air.co2_ppm - before

    world.step(minutes=6, minute_of_day=600)
    before_late = world.air.co2_ppm
    world.step(minutes=1, minute_of_day=600)
    late_minute = world.air.co2_ppm - before_late

    assert late_minute > first_minute * 3, (first_minute, late_minute)


def test_the_entrance_reads_richer_than_the_canopy(model: Model) -> None:
    """Paired sample: 1181 vs 1038 ppm, so ~143 ppm apart around 1110 bulk."""
    world = World(model, WIRING, air=Air(co2_ppm=1110.0, temp_c=23.0, vapour_hpa=16.0))
    entrance = world.read("entrance")
    canopy = world.read("canopy")
    assert entrance.co2_ppm - canopy.co2_ppm == pytest.approx(143, abs=3)


def test_the_gradient_vanishes_with_nothing_running(model: Model) -> None:
    world = World(model, WIRING, air=Air(co2_ppm=420.0, temp_c=15.0, vapour_hpa=12.0))
    for position in ("entrance", "canopy"):
        reading = world.read(position)
        assert reading.co2_ppm == pytest.approx(420, abs=1)
        assert reading.co2_ppm >= model.outdoor_co2_ppm


def test_same_air_different_rh(world: World) -> None:
    entrance = world.read("entrance")
    canopy = world.read("canopy")
    assert entrance.humidity_pct > canopy.humidity_pct

    entrance_vapour = entrance.humidity_pct / 100 * saturation_pressure(entrance.temperature_c)
    canopy_vapour = canopy.humidity_pct / 100 * saturation_pressure(canopy.temperature_c)
    assert entrance_vapour == pytest.approx(canopy_vapour, rel=0.01)


def choose_burner_level(co2_ppm: float, current_level: int, on_at: float, off_at: float) -> int:
    if co2_ppm >= off_at:
        return BURNER_OFF_LEVEL
    if co2_ppm < on_at:
        return BURNER_ON_LEVEL
    return current_level


def run_bang_bang(world: World, *, on_at: float, off_at: float, minutes: int) -> list[tuple]:
    """The real rule: on below on_at, off at or above off_at, dead band between."""
    transitions: list[tuple] = []
    level = BURNER_OFF_LEVEL
    world.set_level(*BURNER, level)
    for minute in range(minutes):
        co2_ppm = world.read("entrance").co2_ppm
        wanted_level = choose_burner_level(co2_ppm, level, on_at, off_at)
        if wanted_level != level:
            level = wanted_level
            world.set_level(*BURNER, level)
            direction = "on" if level == BURNER_ON_LEVEL else "off"
            transitions.append((minute, direction, round(co2_ppm)))
        world.step(minutes=1, minute_of_day=(EVENING_START_MINUTE + minute) % MINUTES_PER_DAY)
    return transitions


def test_golden_burn_cycle_matches_2026_09_10(model: Model) -> None:
    """Measured that night: ~7 min on, ~9 min off, overshooting the cut-off by 46-103 ppm."""
    world = World(model, WIRING, air=Air(co2_ppm=1400.0, temp_c=23.0, vapour_hpa=16.0))
    transitions = run_bang_bang(world, on_at=1400, off_at=1500, minutes=120)

    ons = [transition for transition in transitions if transition[1] == "on"]
    offs = [transition for transition in transitions if transition[1] == "off"]
    assert len(ons) >= 3, f"expected several cycles, got {transitions}"
    assert len(offs) >= 3

    on_durations = [off[0] - on[0] for on, off in zip(ons, offs, strict=False)]
    off_durations = [on[0] - off[0] for off, on in zip(offs, ons[1:], strict=False)]
    # The off-duration bound is loose because the model is knowingly long there; see known_gaps.
    mean_on = sum(on_durations) / len(on_durations)
    mean_off = sum(off_durations) / len(off_durations)
    assert 6 <= mean_on <= 9, on_durations
    assert 8 <= mean_off <= 14, off_durations
    assert 0.30 <= mean_on / (mean_on + mean_off) <= 0.45, (mean_on, mean_off)


def test_overshoot_past_the_cutoff_is_reproduced(model: Model) -> None:
    """Turning off AT the threshold still overshoots, because CO2 is in flight."""
    world = World(model, WIRING, air=Air(co2_ppm=1150.0, temp_c=23.0, vapour_hpa=16.0))
    world.set_level("elantris", 5, 0)
    while world.read("entrance").co2_ppm < 1500:
        world.step(minutes=1, minute_of_day=1050)
    at_cutoff = world.read("entrance").co2_ppm

    world.set_level("elantris", 5, 1)
    peak = at_cutoff
    for _ in range(6):
        world.step(minutes=1, minute_of_day=1050)
        peak = max(peak, world.read("entrance").co2_ppm)

    assert peak > at_cutoff, "the burner keeps delivering after the command"


def test_the_fan_clears_enrichment(world: World) -> None:
    world.set_level("greenhouse", 20, 0)
    before = world.air.co2_ppm
    world.step(minutes=5, minute_of_day=780)
    assert world.air.co2_ppm < before - 100


def test_both_boxes_act_on_one_greenhouse(world: World) -> None:
    """elantris's burner must change what greenhouse's sensor reads."""
    world.set_level("elantris", 5, 0)
    before = world.read("canopy").co2_ppm
    world.step(minutes=10, minute_of_day=600)
    assert world.read("canopy").co2_ppm > before
