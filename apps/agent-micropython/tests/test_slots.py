import json

import pytest

import contract
from slots import HEALTHY, MAX_BOOT_ATTEMPTS, ROLLED_BACK, STATE_FILE, SlotStore, choose_slot_to_boot

COMMAND_ID = "update-1"
NEW_VERSION = "1.2.1"


@pytest.fixture
def store(tmp_path):
    store = SlotStore(str(tmp_path))
    store.write({"active": "a", "pending": None, "outcome": None})
    return store


def test_boots_the_active_slot_when_nothing_is_pending(store):
    assert choose_slot_to_boot(store) == "a"


def test_boots_nothing_on_a_board_that_is_not_on_the_slot_layout(tmp_path):
    assert choose_slot_to_boot(SlotStore(str(tmp_path))) is None


def test_reads_a_damaged_state_file_as_no_slot_layout(tmp_path):
    (tmp_path / STATE_FILE).write_text("{not json")
    assert SlotStore(str(tmp_path)).read() is None


def test_boots_a_pending_slot_and_counts_the_attempt(store):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)

    assert choose_slot_to_boot(store) == "b"
    assert store.read()["pending"]["attempts"] == 1


def test_rolls_back_once_a_pending_slot_has_used_up_its_boots(store):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)
    for _attempt in range(MAX_BOOT_ATTEMPTS):
        assert choose_slot_to_boot(store) == "b"

    assert choose_slot_to_boot(store) == "a"
    state = store.read()
    assert state["pending"] is None
    assert state["outcome"] == {
        "commandId": COMMAND_ID,
        "state": "rolled-back",
        "reason": "%s did not come up healthy in %d boots" % (NEW_VERSION, MAX_BOOT_ATTEMPTS),
    }


def test_keeping_a_pending_slot_makes_it_active_and_records_healthy(store):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)

    store.keep_pending()

    state = store.read()
    assert (state["active"], state["pending"]) == ("b", None)
    assert state["outcome"] == {"commandId": COMMAND_ID, "state": "healthy", "reason": None}
    assert choose_slot_to_boot(store) == "b"


def test_abandoning_a_pending_slot_keeps_the_active_one_and_says_why(store):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)

    store.abandon_pending("the server did not accept it")

    state = store.read()
    assert (state["active"], state["pending"]) == ("a", None)
    assert state["outcome"]["reason"] == "the server did not accept it"


def test_writes_the_state_whole_and_leaves_no_unfinished_file(store, tmp_path):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)

    assert sorted(path.name for path in tmp_path.iterdir()) == [STATE_FILE]
    assert json.loads((tmp_path / STATE_FILE).read_text())["pending"]["slot"] == "b"


def write_raw_state(tmp_path, state):
    (tmp_path / STATE_FILE).write_text(json.dumps(state))
    return SlotStore(str(tmp_path))


@pytest.mark.parametrize(
    "pending",
    [
        {"slot": "b", "commandId": COMMAND_ID, "version": NEW_VERSION},
        {"slot": "b", "commandId": COMMAND_ID, "version": NEW_VERSION, "attempts": "1"},
        {"slot": "a", "commandId": COMMAND_ID, "version": NEW_VERSION, "attempts": 0},
        {"slot": "c", "commandId": COMMAND_ID, "version": NEW_VERSION, "attempts": 0},
        "b",
    ],
)
def test_boots_the_active_slot_past_a_pending_entry_it_cannot_count(tmp_path, pending):
    store = write_raw_state(tmp_path, {"active": "a", "pending": pending, "outcome": None})

    assert choose_slot_to_boot(store) == "a"
    assert store.read()["pending"] is None


def test_reads_a_damaged_outcome_as_none(tmp_path):
    store = write_raw_state(tmp_path, {"active": "a", "pending": None, "outcome": "healthy"})
    assert store.read()["outcome"] is None


def test_boots_the_active_slot_when_the_attempt_cannot_be_written(store, monkeypatch):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)

    def refuse_to_write(state):
        raise OSError(28)

    monkeypatch.setattr(store, "write", refuse_to_write)

    assert choose_slot_to_boot(store) == "a"


def test_boots_the_active_slot_when_a_roll_back_cannot_be_written(store, monkeypatch):
    store.start_pending("b", COMMAND_ID, NEW_VERSION)
    for _attempt in range(MAX_BOOT_ATTEMPTS):
        choose_slot_to_boot(store)

    def refuse_to_write(state):
        raise OSError(28)

    monkeypatch.setattr(store, "write", refuse_to_write)

    assert choose_slot_to_boot(store) == "a"


def test_outcome_states_match_the_contract():
    assert (HEALTHY, ROLLED_BACK) == (contract.UpdateState.HEALTHY, contract.UpdateState.ROLLED_BACK)
