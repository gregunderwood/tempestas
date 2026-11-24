"""The health gate and what a start owes the server after an update."""

from __future__ import annotations

import os

from release_fixtures import NEW_RELEASE, RUNNING_RELEASE, make_layout
from tempestas_agent import contract
from tempestas_agent.release_layout import KEPT_RELEASES, PendingUpdate, UpdateOutcome
from tempestas_agent.update_gate import (
    GATE_SECONDS,
    HealthGate,
    pass_gate,
    roll_back_gate,
    settle_update_on_start,
)

STARTED_AT = 1000.0
PENDING = PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE)


def install_new_release(layout) -> None:
    layout.release_path(NEW_RELEASE).mkdir()
    layout.write_pending(PENDING)
    layout.switch_current_to(NEW_RELEASE)


def test_a_start_with_no_update_owes_nothing(tmp_path):
    settlement = settle_update_on_start(make_layout(tmp_path), STARTED_AT)
    assert (settlement.gate, settlement.outcome) == (None, None)


def test_a_start_outside_a_release_owes_nothing():
    settlement = settle_update_on_start(None, STARTED_AT)
    assert (settlement.gate, settlement.outcome) == (None, None)


def test_the_new_release_starts_under_a_health_gate(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)

    settlement = settle_update_on_start(layout, STARTED_AT)

    assert settlement.gate.pending == PENDING
    assert settlement.outcome is None


def test_a_release_the_rollback_unit_switched_away_from_is_reported_rolled_back(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    layout.switch_current_to(RUNNING_RELEASE)

    settlement = settle_update_on_start(layout, STARTED_AT)

    assert settlement.gate is None
    assert settlement.outcome.state == contract.UpdateState.ROLLED_BACK
    assert (
        settlement.outcome.reason == f"{NEW_RELEASE} did not start, so {RUNNING_RELEASE} runs again"
    )
    assert layout.read_pending() is None
    assert layout.read_outcome() == settlement.outcome


def test_an_outcome_left_by_the_last_run_is_still_owed(tmp_path):
    layout = make_layout(tmp_path)
    outcome = UpdateOutcome("update-1", contract.UpdateState.ROLLED_BACK, "no heartbeat")
    layout.write_outcome(outcome)

    assert settle_update_on_start(layout, STARTED_AT).outcome == outcome


def test_the_gate_passes_on_a_heartbeat_after_hello():
    gate = HealthGate(PENDING, STARTED_AT)
    gate.note_hello()
    gate.note_heartbeat()
    assert gate.is_passed() is True


def test_a_heartbeat_before_hello_does_not_pass_the_gate():
    gate = HealthGate(PENDING, STARTED_AT)
    gate.note_heartbeat()
    gate.note_hello()
    assert gate.is_passed() is False


def test_the_gate_is_overdue_only_once_its_time_is_up():
    gate = HealthGate(PENDING, STARTED_AT)
    gate.note_hello()
    assert gate.is_overdue(STARTED_AT + GATE_SECONDS - 1) is False
    assert gate.is_overdue(STARTED_AT + GATE_SECONDS) is True
    assert gate.describe_failure() == f"{NEW_RELEASE} sent no heartbeat within {GATE_SECONDS}s"


def test_a_failed_gate_puts_the_previous_release_back_and_records_why(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    gate = HealthGate(PENDING, STARTED_AT)

    roll_back_gate(layout, gate)

    assert layout.read_current_release() == RUNNING_RELEASE
    assert layout.read_pending() is None
    assert layout.read_outcome() == UpdateOutcome(
        "update-1", contract.UpdateState.ROLLED_BACK, f"{NEW_RELEASE} sent no hello within 120s"
    )


def test_a_passed_gate_keeps_the_newest_releases_and_both_ends_of_the_update(tmp_path):
    layout = make_layout(tmp_path)
    older_releases = [f"1.0.{patch}" for patch in range(KEPT_RELEASES + 1)]
    for age, release in enumerate(older_releases):
        layout.release_path(release).mkdir()
        stamp = 100 + age
        os.utime(layout.release_path(release), (stamp, stamp))
    install_new_release(layout)

    pass_gate(layout, HealthGate(PENDING, STARTED_AT))

    kept = sorted(entry.name for entry in layout.releases.iterdir())
    assert NEW_RELEASE in kept and RUNNING_RELEASE in kept
    assert kept == sorted([NEW_RELEASE, RUNNING_RELEASE, older_releases[-1]])
    assert layout.read_pending() is None
