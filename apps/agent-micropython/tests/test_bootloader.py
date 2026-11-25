import sys
import types

import pytest

from bootloader import (
    BOOT_GRACE_MILLISECONDS,
    GRACE_POLL_MILLISECONDS,
    PENDING_SLOT_DEADLINE_MILLISECONDS,
    Board,
    boot,
    is_bootsel_pressed,
    run_slot_from,
)
from fakes import RecordingLog
from slots import SlotStore


class FakeBootBoard(Board):
    def __init__(self, bootsel_pressed_after_milliseconds=None):
        self.slept_milliseconds = 0
        self.resets = 0
        self.bootsel_pressed_after_milliseconds = bootsel_pressed_after_milliseconds
        self.timers = []
        super().__init__(self.sleep, self.read_bootsel, self.count_reset, self.start_timer)

    def sleep(self, milliseconds):
        self.slept_milliseconds += milliseconds

    def read_bootsel(self):
        pressed_after = self.bootsel_pressed_after_milliseconds
        return pressed_after is not None and self.slept_milliseconds >= pressed_after

    def count_reset(self):
        self.resets += 1

    def start_timer(self, milliseconds, callback):
        self.timers.append((milliseconds, callback))

    def fire_timers(self):
        for _milliseconds, callback in self.timers:
            callback(None)


class SlotRunner:
    def __init__(self, failure=None):
        self.ran = []
        self.failure = failure

    def __call__(self, slot_directory):
        self.ran.append(slot_directory)
        if self.failure is not None:
            raise self.failure


@pytest.fixture
def store(tmp_path):
    store = SlotStore(str(tmp_path))
    store.write({"active": "a", "pending": None, "outcome": None})
    return store


def test_waits_out_the_boot_grace_then_runs_the_active_slot(store):
    board = FakeBootBoard()
    run_slot = SlotRunner()

    boot(board, store, run_slot, RecordingLog())

    assert board.slept_milliseconds == BOOT_GRACE_MILLISECONDS
    assert run_slot.ran == [store.locate("a")]


def test_bootsel_pressed_during_the_grace_runs_no_slot(store):
    board = FakeBootBoard(bootsel_pressed_after_milliseconds=GRACE_POLL_MILLISECONDS * 3)
    run_slot = SlotRunner()
    log = RecordingLog()

    boot(board, store, run_slot, log)

    assert run_slot.ran == []
    assert any("safe mode" in line for line in log.lines)


def test_bootsel_leaves_a_pending_slot_its_attempts(store):
    store.start_pending("b", "update-1", "1.2.1")

    boot(FakeBootBoard(bootsel_pressed_after_milliseconds=0), store, SlotRunner(), RecordingLog())

    assert store.read()["pending"]["attempts"] == 0


def test_a_slot_that_raises_resets_the_board_so_the_attempt_counts(store):
    store.start_pending("b", "update-1", "1.2.1")
    board = FakeBootBoard()

    boot(board, store, SlotRunner(failure=ImportError("no module named node_runtime")), RecordingLog())

    assert board.resets == 1
    assert store.read()["pending"]["attempts"] == 1


def test_ctrl_c_in_a_slot_leaves_the_repl_rather_than_resetting(store):
    board = FakeBootBoard()

    with pytest.raises(KeyboardInterrupt):
        boot(board, store, SlotRunner(failure=KeyboardInterrupt()), RecordingLog())

    assert board.resets == 0


def test_a_board_not_on_the_slot_layout_runs_nothing_and_says_how_to_fix_it(tmp_path):
    run_slot = SlotRunner()
    log = RecordingLog()

    boot(FakeBootBoard(), SlotStore(str(tmp_path)), run_slot, log)

    assert run_slot.ran == []
    assert any("deploy-agent-micropython.sh" in line for line in log.lines)


def test_a_pending_slot_gets_a_deadline_that_resets_it_while_still_pending(store):
    store.start_pending("b", "update-1", "1.2.1")
    board = FakeBootBoard()

    boot(board, store, SlotRunner(), RecordingLog())
    board.fire_timers()

    assert [milliseconds for milliseconds, _callback in board.timers] == [PENDING_SLOT_DEADLINE_MILLISECONDS]
    assert board.resets == 1


def test_a_pending_slot_kept_before_its_deadline_is_not_reset(store):
    store.start_pending("b", "update-1", "1.2.1")
    board = FakeBootBoard()

    boot(board, store, SlotRunner(), RecordingLog())
    store.keep_pending()
    board.fire_timers()

    assert board.resets == 0


def test_the_active_slot_gets_no_deadline(store):
    board = FakeBootBoard()
    boot(board, store, SlotRunner(), RecordingLog())
    assert board.timers == []


def test_the_active_slot_it_falls_back_to_gets_no_deadline(store, monkeypatch):
    store.start_pending("b", "update-1", "1.2.1")
    board = FakeBootBoard()

    def refuse_to_write(state):
        raise OSError(28)

    monkeypatch.setattr(store, "write", refuse_to_write)
    run_slot = SlotRunner()
    boot(board, store, run_slot, RecordingLog())

    assert run_slot.ran == [store.locate("a")]
    assert board.timers == []


def install_rp2(monkeypatch, rp2_module):
    monkeypatch.setitem(sys.modules, "rp2", rp2_module)


def test_reads_bootsel_through_rp2(monkeypatch):
    install_rp2(monkeypatch, types.SimpleNamespace(bootsel_button=lambda: 1))
    assert is_bootsel_pressed()


def test_reads_an_unpressed_bootsel_as_not_pressed(monkeypatch):
    install_rp2(monkeypatch, types.SimpleNamespace(bootsel_button=lambda: 0))
    assert not is_bootsel_pressed()


def test_reads_a_firmware_without_the_button_as_not_pressed(monkeypatch):
    install_rp2(monkeypatch, types.SimpleNamespace())
    assert not is_bootsel_pressed()


def test_reads_a_port_without_rp2_as_not_pressed(monkeypatch):
    install_rp2(monkeypatch, None)
    assert not is_bootsel_pressed()


def test_runs_the_slots_own_node_runtime_ahead_of_any_other(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.delitem(sys.modules, "node_runtime", raising=False)
    (tmp_path / "node_runtime.py").write_text("def run():\n    open(__file__ + '.ran', 'w').close()\n")

    run_slot_from(str(tmp_path))

    assert (tmp_path / "node_runtime.py.ran").exists()
    assert sys.path[0] == str(tmp_path)
    sys.modules.pop("node_runtime", None)


def test_a_deadline_that_cannot_read_the_state_resets_anyway(store, monkeypatch):
    store.start_pending("b", "update-1", "1.2.1")
    board = FakeBootBoard()
    boot(board, store, SlotRunner(), RecordingLog())

    def run_out_of_memory():
        raise MemoryError()

    monkeypatch.setattr(store, "read", run_out_of_memory)
    board.fire_timers()

    assert board.resets == 1
