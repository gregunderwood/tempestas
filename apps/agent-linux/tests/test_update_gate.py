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
    prune_after_update,
    roll_back_gate,
    settle_update_on_start,
)

STARTED_AT = 1000.0
PENDING = PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE)


def install_new_release(layout) -> None:
    layout.locate_release(NEW_RELEASE).mkdir()
    layout.write_pending(PENDING)
    layout.switch_current_to(NEW_RELEASE)


def test_a_start_with_no_update_owes_nothing(tmp_path):
    settlement = settle_update_on_start(make_layout(tmp_path))
    assert (settlement.gate, settlement.outcome) == (None, None)


def test_a_start_outside_a_release_owes_nothing():
    settlement = settle_update_on_start(None)
    assert (settlement.gate, settlement.outcome) == (None, None)


def test_the_new_release_starts_under_a_health_gate(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)

    settlement = settle_update_on_start(layout)

    assert settlement.gate.pending == PENDING
    assert settlement.outcome is None


def test_a_release_the_rollback_unit_switched_away_from_is_reported_rolled_back(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    layout.switch_current_to(RUNNING_RELEASE)

    settlement = settle_update_on_start(layout)

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

    assert settle_update_on_start(layout).outcome == outcome


def test_the_gate_passes_on_a_heartbeat_after_hello():
    gate = HealthGate(PENDING)
    gate.note_hello()
    gate.note_heartbeat()
    assert gate.is_passed() is True


def test_a_heartbeat_before_hello_does_not_pass_the_gate():
    gate = HealthGate(PENDING)
    gate.note_heartbeat()
    gate.note_hello()
    assert gate.is_passed() is False


def test_the_gate_is_overdue_only_once_its_time_is_up():
    gate = HealthGate(PENDING)
    gate.note_hello()
    gate.start_watching(STARTED_AT)
    assert gate.is_overdue(STARTED_AT + GATE_SECONDS - 1) is False
    assert gate.is_overdue(STARTED_AT + GATE_SECONDS) is True
    assert gate.describe_failure() == (
        f"{NEW_RELEASE} heard no heartbeat in {GATE_SECONDS}s with the server online"
    )


def test_the_gate_never_runs_out_before_it_has_started_watching():
    gate = HealthGate(PENDING)
    assert gate.is_overdue(STARTED_AT + 10 * GATE_SECONDS) is False


def test_time_with_the_server_away_does_not_count_against_the_gate():
    gate = HealthGate(PENDING)
    gate.start_watching(STARTED_AT)
    gate.stop_watching(STARTED_AT + GATE_SECONDS - 10)
    later = STARTED_AT + 10 * GATE_SECONDS
    gate.start_watching(later)

    assert gate.is_overdue(later + 9) is False
    assert gate.is_overdue(later + 10) is True


def test_watching_again_while_already_watching_keeps_the_earlier_start():
    gate = HealthGate(PENDING)
    gate.start_watching(STARTED_AT)
    gate.start_watching(STARTED_AT + 100)
    assert gate.read_watched_seconds(STARTED_AT + GATE_SECONDS) == GATE_SECONDS


def test_a_failed_gate_puts_the_previous_release_back_and_records_why(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    gate = HealthGate(PENDING)

    roll_back_gate(layout, gate)

    assert layout.read_current_release() == RUNNING_RELEASE
    assert layout.read_pending() is None
    assert layout.read_outcome() == UpdateOutcome(
        "update-1",
        contract.UpdateState.ROLLED_BACK,
        f"{NEW_RELEASE} heard no heartbeat in 120s with the server online",
    )


def test_a_passed_gate_keeps_the_newest_releases_and_both_ends_of_the_update(tmp_path):
    layout = make_layout(tmp_path)
    older_releases = [f"1.0.{patch}" for patch in range(KEPT_RELEASES + 1)]
    for age, release in enumerate(older_releases):
        layout.locate_release(release).mkdir()
        stamp = 100 + age
        os.utime(layout.locate_release(release), (stamp, stamp))
    install_new_release(layout)

    pass_gate(layout, HealthGate(PENDING))
    prune_after_update(layout, PENDING)

    kept = sorted(entry.name for entry in layout.releases.iterdir())
    assert NEW_RELEASE in kept and RUNNING_RELEASE in kept
    assert kept == sorted([NEW_RELEASE, RUNNING_RELEASE, older_releases[-1]])
    assert layout.read_pending() is None
    assert layout.read_outcome() == UpdateOutcome("update-1", contract.UpdateState.HEALTHY)


def test_a_prune_skips_a_release_another_prune_removed_first(tmp_path, monkeypatch):
    layout = make_layout(tmp_path)
    older_releases = [f"1.0.{patch}" for patch in range(KEPT_RELEASES + 1)]
    for release in older_releases:
        layout.locate_release(release).mkdir()
    vanished = layout.locate_release(older_releases[0])
    real_stat = type(vanished).stat

    def stat_after_another_prune(path, *arguments, **options):
        if path == vanished:
            raise FileNotFoundError(path)
        return real_stat(path, *arguments, **options)

    monkeypatch.setattr(type(vanished), "stat", stat_after_another_prune)

    layout.prune_releases(protected={RUNNING_RELEASE})


def test_an_unreadable_pending_record_is_dropped_rather_than_stopping_the_start(tmp_path):
    layout = make_layout(tmp_path)
    layout.state.mkdir()
    (layout.state / "pending.json").write_text("")

    assert settle_update_on_start(layout).gate is None
    assert not (layout.state / "pending.json").exists()
