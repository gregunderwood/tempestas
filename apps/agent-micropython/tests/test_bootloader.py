import pytest

from bootloader import BOOT_GRACE_MILLISECONDS, GRACE_POLL_MILLISECONDS, Board, boot
from fakes import RecordingLog
from slots import SlotStore


class FakeBootBoard(Board):
    def __init__(self, bootsel_pressed_after_milliseconds=None):
        self.slept_milliseconds = 0
        self.resets = 0
        self.bootsel_pressed_after_milliseconds = bootsel_pressed_after_milliseconds
        super().__init__(self.sleep, self.read_bootsel, self.count_reset)

    def sleep(self, milliseconds):
        self.slept_milliseconds += milliseconds

    def read_bootsel(self):
        pressed_after = self.bootsel_pressed_after_milliseconds
        return pressed_after is not None and self.slept_milliseconds >= pressed_after

    def count_reset(self):
        self.resets += 1


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
