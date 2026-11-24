"""A hand deploy makes the copied release current and drops an unfinished update."""

from __future__ import annotations

from release_fixtures import NEW_RELEASE, RUNNING_RELEASE, make_layout
from tempestas_agent import contract
from tempestas_agent.hand_deploy import main, make_current
from tempestas_agent.release_layout import PendingUpdate, UpdateOutcome


def test_makes_the_copied_release_current_and_drops_a_waiting_update(tmp_path):
    layout = make_layout(tmp_path)
    layout.locate_release(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", "1.1.9", RUNNING_RELEASE))

    make_current(layout, NEW_RELEASE)

    assert layout.read_current_release() == NEW_RELEASE
    assert layout.read_pending() is None
    assert layout.locate_release(RUNNING_RELEASE).is_dir()


def test_tells_the_server_that_the_update_it_replaced_ended(tmp_path):
    layout = make_layout(tmp_path)
    layout.locate_release(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    layout.switch_current_to(NEW_RELEASE)
    layout.locate_release("1.1.5").mkdir()

    make_current(layout, "1.1.5")

    assert layout.read_pending() is None
    assert layout.read_outcome() == UpdateOutcome(
        "update-1",
        contract.UpdateState.FAILED,
        "replaced by a hand deploy of 1.1.5 before its health gate passed",
    )


def test_keeps_saying_an_update_did_not_start_once_it_was_rolled_back(tmp_path):
    layout = make_layout(tmp_path)
    layout.locate_release(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    layout.locate_release("1.1.5").mkdir()

    make_current(layout, "1.1.5")

    assert layout.read_outcome() == UpdateOutcome(
        "update-1",
        contract.UpdateState.ROLLED_BACK,
        f"{NEW_RELEASE} did not start, so {RUNNING_RELEASE} runs again",
    )


def test_redeploying_the_version_on_its_gate_leaves_the_gate_to_judge_it(tmp_path):
    layout = make_layout(tmp_path)
    layout.locate_release(NEW_RELEASE).mkdir()
    pending = PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE)
    layout.write_pending(pending)
    layout.switch_current_to(NEW_RELEASE)

    make_current(layout, NEW_RELEASE)

    assert layout.read_pending() == pending
    assert layout.read_outcome() is None


def test_refuses_a_release_that_was_never_copied(tmp_path, monkeypatch):
    monkeypatch.setenv("TEMPESTAS_AGENT_HOME", str(tmp_path))
    make_layout(tmp_path)

    assert main(["9.9.9"]) == 1


def test_needs_the_home_and_a_release(monkeypatch):
    monkeypatch.delenv("TEMPESTAS_AGENT_HOME", raising=False)
    assert main([NEW_RELEASE]) == 2
