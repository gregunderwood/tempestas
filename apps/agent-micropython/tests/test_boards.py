from pathlib import Path

import pytest

import settings
from fakes import BOARDS, FakeMachine, load_board


class FakeWifi:
    def __init__(self):
        self.settings = {}

    def config(self, **settings_to_apply):
        self.settings.update(settings_to_apply)


def test_the_configured_board_exists():
    assert (BOARDS / (settings.BOARD + ".py")).is_file()


def test_every_board_offers_what_the_agent_calls():
    for board_path in Path(BOARDS).glob("*.py"):
        board = load_board(board_path.stem, FakeMachine())
        for function_name in (
            "is_pin_driven",
            "is_pin_driven_high",
            "keep_wifi_awake",
            "refuse_if_watchdog_armed",
        ):
            assert callable(getattr(board, function_name)), (board_path.stem, function_name)


def test_pico_w_reads_a_driven_low_pin_from_the_sio_registers():
    machine = FakeMachine()
    board = load_board("pico_w", machine)
    machine.Pin(20, machine.Pin.OUT, value=0)
    assert board.is_pin_driven(20) and not board.is_pin_driven_high(20)
    assert not board.is_pin_driven(18)


def test_pico_w_turns_off_wifi_power_saving():
    wifi = FakeWifi()
    load_board("pico_w", FakeMachine()).keep_wifi_awake(wifi)
    assert wifi.settings == {"pm": 0xA11140}


def test_pico_w_refuses_a_deploy_once_the_watchdog_is_armed():
    machine = FakeMachine()
    board = load_board("pico_w", machine)
    board.refuse_if_watchdog_armed()
    machine.is_watchdog_armed = True
    with pytest.raises(RuntimeError, match="watchdog already armed"):
        board.refuse_if_watchdog_armed()
