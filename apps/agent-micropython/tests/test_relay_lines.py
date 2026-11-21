import pytest

from fakes import FakeMachine, load_board
from relay_lines import DRIVEN_LOW_LEVEL, RELEASED_LEVEL, ReleasedWhenHighLines, UnmanagedPin

HEATER_PIN = 20
HEAT_TAPE_PIN = 18


def build_lines():
    machine = FakeMachine()
    failsafe_levels = {HEATER_PIN: RELEASED_LEVEL, HEAT_TAPE_PIN: RELEASED_LEVEL}
    board = load_board("pico_w", machine)
    return machine, ReleasedWhenHighLines(machine, board, (HEATER_PIN, HEAT_TAPE_PIN), failsafe_levels)


def test_level_zero_drives_the_pin_low_and_reads_back_zero():
    machine, lines = build_lines()
    lines.write(HEATER_PIN, DRIVEN_LOW_LEVEL)
    assert machine.modes[HEATER_PIN] == machine.Pin.OUT
    assert lines.read_level(HEATER_PIN) == DRIVEN_LOW_LEVEL


def test_level_one_releases_the_pin_rather_than_driving_it_high():
    machine, lines = build_lines()
    lines.write(HEATER_PIN, DRIVEN_LOW_LEVEL)
    lines.write(HEATER_PIN, RELEASED_LEVEL)
    assert machine.modes[HEATER_PIN] == machine.Pin.IN
    assert lines.read_level(HEATER_PIN) == RELEASED_LEVEL


def test_failsafe_releases_every_line():
    machine, lines = build_lines()
    lines.write(HEATER_PIN, DRIVEN_LOW_LEVEL)
    lines.write(HEAT_TAPE_PIN, DRIVEN_LOW_LEVEL)
    lines.failsafe()
    assert [lines.read_level(pin) for pin in (HEATER_PIN, HEAT_TAPE_PIN)] == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_reads_the_chip_not_the_last_request():
    machine, lines = build_lines()
    lines.write(HEATER_PIN, DRIVEN_LOW_LEVEL)
    machine.Pin(HEATER_PIN, machine.Pin.IN)
    assert lines.read_level(HEATER_PIN) == RELEASED_LEVEL


def test_refuses_a_pin_it_does_not_manage_and_a_level_that_is_not_a_level():
    _, lines = build_lines()
    with pytest.raises(UnmanagedPin):
        lines.write(3, DRIVEN_LOW_LEVEL)
    with pytest.raises(ValueError):
        lines.write(HEATER_PIN, 2)
