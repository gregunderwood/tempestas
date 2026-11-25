import importlib
import sys
import types

import bootloader

ONE_SHOT = "one-shot"


class FakeTimer:
    ONE_SHOT = ONE_SHOT
    started = []

    def __init__(self, mode, period, callback):
        FakeTimer.started.append((mode, period, callback))


def test_wires_the_chip_into_the_bootloader_and_holds_each_timer(monkeypatch):
    resets = []
    booted = []
    fake_machine = types.SimpleNamespace(Timer=FakeTimer, reset=lambda: resets.append(True))
    monkeypatch.setitem(sys.modules, "machine", fake_machine)
    monkeypatch.setattr(sys.modules["time"], "sleep_ms", lambda milliseconds: None, raising=False)
    monkeypatch.setattr(bootloader, "boot", lambda board, store, run_slot, log: booted.append(board))
    monkeypatch.delitem(sys.modules, "main", raising=False)

    main = importlib.import_module("main")
    board = booted[0]
    board.start_one_shot_timer(600000, print)
    board.reset()

    assert board.is_bootsel_pressed is bootloader.is_bootsel_pressed
    assert FakeTimer.started == [(ONE_SHOT, 600000, print)]
    assert len(main.started_timers) == 1
    assert resets == [True]
    sys.modules.pop("main", None)
