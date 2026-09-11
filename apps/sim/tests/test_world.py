"""The simulator is only worth having if it reproduces the greenhouse we measured."""

from __future__ import annotations

from pathlib import Path

import pytest

from tempestas_sim.world import (
    ROLE_CO2,
    ROLE_FAN,
    ROLE_HPS,
    ROLE_MH,
    Air,
    Fixture,
    Model,
    World,
    saturation_pressure,
)

MODEL_PATH = Path(__file__).resolve().parents[1] / "greenhouse-model.json"

# Wired exactly as the two boxes are. Four active-LOW channels and one
# active-HIGH module, which is the trap this fixture list exists to hold.
WIRING = [
    Fixture("elantris", 5, ROLE_CO2, on_level=0),
    Fixture("greenhouse", 21, ROLE_HPS, on_level=0),
    Fixture("greenhouse", 20, ROLE_FAN, on_level=0),
    Fixture("greenhouse", 26, ROLE_MH, on_level=1),
    Fixture("greenhouse", 16, "none", on_level=0),
    Fixture("greenhouse", 12, "none", on_level=0),
]


@pytest.fixture
def model() -> Model:
    return Model.load(MODEL_PATH)


@pytest.fixture
def world(model: Model) -> World:
    return World(model, WIRING, air=Air(co2_ppm=1400.0, temp_c=23.0, vapour_hpa=16.0))


def test_polarity_is_per_fixture_not_per_board(world: World) -> None:
    """Driving every line LOW must turn the MH light OFF, not on.

    This is the migration bug that would light a lamp, and it is the reason
    the simulator carries on_level per fixture.
    """
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
    """BCM 16 and 12 accept commands and change no state anywhere."""
    before = world.read("canopy")
    for pin in (16, 12):
        world.set_level("greenhouse", pin, 0)
    world.step(minutes=10, minute_of_day=600)
    after = world.read("canopy")
    # Only the passive terms moved; nothing was actuated.
    assert after.co2_ppm < before.co2_ppm, "CO2 should just be leaking away"


def test_the_burner_arrives_at_the_sensor_gradually(world: World) -> None:
    """Transport lag: barely anything in the first minute, full rate later.

    Asserts the SHAPE rather than a threshold, because the lag is first-order -
    the same mechanism that makes the level keep climbing after the burner is
    commanded off.
    """
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
    """The measured gradient, at the level it was measured at.

    Paired sample: 1181 vs 1038 ppm, so ~143 ppm apart around 1110 bulk.
    """
    world = World(model, WIRING, air=Air(co2_ppm=1110.0, temp_c=23.0, vapour_hpa=16.0))
    entrance = world.read("entrance")
    canopy = world.read("canopy")
    assert entrance.co2_ppm - canopy.co2_ppm == pytest.approx(143, abs=3)


def test_the_gradient_vanishes_with_nothing_running(model: Model) -> None:
    """No enrichment, no gradient - and never a site below outdoor air.

    A flat offset put the canopy at 348 ppm against 420 outdoor, which cannot
    happen: there is nothing to be leaner than the air coming in.
    """
    world = World(model, WIRING, air=Air(co2_ppm=420.0, temp_c=15.0, vapour_hpa=12.0))
    for position in ("entrance", "canopy"):
        reading = world.read(position)
        assert reading.co2_ppm == pytest.approx(420, abs=1)
        assert reading.co2_ppm >= model.outdoor_co2_ppm


def test_same_air_different_rh(world: World) -> None:
    """Two sensors, one vapour pressure, two indicated RH values.

    Reproduces the paired sample. If this ever passes by both sites agreeing on
    RH, the model has started storing the artefact instead of the physics.
    """
    entrance = world.read("entrance")
    canopy = world.read("canopy")
    assert entrance.humidity_pct > canopy.humidity_pct

    e_vapour = entrance.humidity_pct / 100 * saturation_pressure(entrance.temperature_c)
    c_vapour = canopy.humidity_pct / 100 * saturation_pressure(canopy.temperature_c)
    assert e_vapour == pytest.approx(c_vapour, rel=0.01)


def run_bang_bang(world: World, *, on_at: float, off_at: float, minutes: int) -> list[tuple]:
    """The real rule: on below on_at, off at or above off_at, dead band between."""
    transitions: list[tuple] = []
    # 1 is DE-energised on this active-LOW channel. Start off, and start the
    # bookkeeping in the state we actually put the line in.
    state = 1
    world.set_level("elantris", 5, state)
    for t in range(minutes):
        co2 = world.read("entrance").co2_ppm
        want = state
        if co2 >= off_at:
            want = 1  # off
        elif co2 < on_at:
            want = 0  # on
        if want != state:
            state = want
            world.set_level("elantris", 5, state)
            transitions.append((t, "on" if state == 0 else "off", round(co2)))
        world.step(minutes=1, minute_of_day=(17 * 60 + t) % 1440)
    return transitions


def test_golden_burn_cycle_matches_2026_09_10(model: Model) -> None:
    """The evening of 2026-09-10: four cycles under the 1400/1500 rule.

    Measured that night - ~7 min on, ~9 min off, and an overshoot of +46 to
    +103 ppm past the 1500 cut-off caused by the burner's warm-up lag. If the
    simulator cannot produce that shape, it cannot be used to tune the rule.
    """
    world = World(model, WIRING, air=Air(co2_ppm=1400.0, temp_c=23.0, vapour_hpa=16.0))
    transitions = run_bang_bang(world, on_at=1400, off_at=1500, minutes=120)

    ons = [t for t in transitions if t[1] == "on"]
    offs = [t for t in transitions if t[1] == "off"]
    assert len(ons) >= 3, f"expected several cycles, got {transitions}"
    assert len(offs) >= 3

    on_durations = [off[0] - on[0] for on, off in zip(ons, offs, strict=False)]
    off_durations = [on[0] - off[0] for off, on in zip(offs, ons[1:], strict=False)]
    assert 4 <= sum(on_durations) / len(on_durations) <= 11, on_durations
    assert 5 <= sum(off_durations) / len(off_durations) <= 14, off_durations


def test_overshoot_past_the_cutoff_is_reproduced(model: Model) -> None:
    """Turning off AT the threshold still overshoots, because heat is in flight."""
    # Start well below the cut-off so the burner actually runs, and the
    # in-flight reservoir has filled by the time it is commanded off.
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
    """elantris's burner must change what greenhouse's sensor reads.

    A per-agent simulator cannot express this, and it is the whole reason the
    world is a shared service rather than a field on each agent.
    """
    world.set_level("elantris", 5, 0)
    before = world.read("canopy").co2_ppm
    world.step(minutes=10, minute_of_day=600)
    assert world.read("canopy").co2_ppm > before
