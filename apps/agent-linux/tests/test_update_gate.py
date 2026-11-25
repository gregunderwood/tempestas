"""The health gate and what a start owes the server after an update."""

from __future__ import annotations

import os
import shutil

import pytest

from release_fixtures import NEW_RELEASE, RUNNING_RELEASE, make_layout
from tempestas_agent import contract
from tempestas_agent.release_layout import (
    KEPT_RELEASES,
    PendingUpdate,
    StartedUpdate,
    UpdateOutcome,
)
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
HEARTBEAT_FROM_A_1_1_SERVER = {"controller": "ctl", "epoch": 1}


def heartbeat_naming(accepted_version: str | None) -> dict:
    return {**HEARTBEAT_FROM_A_1_1_SERVER, contract.HEARTBEAT_ACCEPTED_VERSION: accepted_version}


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


def test_an_outcome_recorded_just_before_a_crash_settles_the_update_without_a_new_gate(
    tmp_path,
):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    healthy = UpdateOutcome(PENDING.command_id, contract.UpdateState.HEALTHY)
    layout.write_outcome(healthy)

    settlement = settle_update_on_start(layout)

    assert (settlement.gate, settlement.outcome) == (None, healthy)
    assert layout.read_pending() is None


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


def test_a_release_rolled_back_after_it_started_is_not_reported_as_never_starting(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    layout.write_started(StartedUpdate(PENDING.command_id))
    layout.switch_current_to(RUNNING_RELEASE)

    settlement = settle_update_on_start(layout)

    assert settlement.outcome.reason == (
        f"{NEW_RELEASE} kept failing after it started, so {RUNNING_RELEASE} runs again"
    )


def test_a_rollback_whose_reason_was_recorded_keeps_that_reason(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    recorded = UpdateOutcome(PENDING.command_id, contract.UpdateState.ROLLED_BACK, "no heartbeat")
    layout.write_outcome(recorded)
    layout.switch_current_to(RUNNING_RELEASE)

    settlement = settle_update_on_start(layout)

    assert settlement.outcome == recorded
    assert layout.read_pending() is None


def test_a_start_removes_abandoned_downloads_but_not_a_hand_deploy_in_progress(tmp_path):
    layout = make_layout(tmp_path)
    layout.locate_unfinished_release(NEW_RELEASE).mkdir()
    hand_deploy_staging = layout.releases / f".deploy-{NEW_RELEASE}"
    hand_deploy_staging.mkdir()

    removed = layout.remove_unfinished_downloads()

    assert removed == [f".{NEW_RELEASE}"]
    assert hand_deploy_staging.is_dir()
    assert layout.locate_release(RUNNING_RELEASE).is_dir()


def test_a_failed_gate_with_nothing_to_roll_back_to_keeps_the_release_and_says_so(tmp_path):
    layout = make_layout(tmp_path)
    install_new_release(layout)
    shutil.rmtree(layout.locate_release(RUNNING_RELEASE))

    outcome = roll_back_gate(layout, HealthGate(PENDING))

    assert layout.read_current_release() == NEW_RELEASE
    assert layout.read_pending() is None
    assert outcome.state == contract.UpdateState.FAILED
    assert f"{RUNNING_RELEASE} to roll back to is missing" in outcome.reason


def test_an_outcome_left_by_the_last_run_is_still_owed(tmp_path):
    layout = make_layout(tmp_path)
    outcome = UpdateOutcome("update-1", contract.UpdateState.ROLLED_BACK, "no heartbeat")
    layout.write_outcome(outcome)

    assert settle_update_on_start(layout).outcome == outcome


def test_the_gate_passes_on_a_heartbeat_after_hello():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
    gate.note_heartbeat(HEARTBEAT_FROM_A_1_1_SERVER)
    assert gate.is_passed() is True


def test_the_gate_passes_on_a_heartbeat_naming_the_version_the_server_accepted():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
    gate.note_heartbeat(heartbeat_naming(NEW_RELEASE))
    assert gate.is_passed() is True


def test_a_server_still_naming_the_old_version_has_not_accepted_the_new_hello():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
    gate.start_watching(STARTED_AT)
    gate.note_heartbeat(heartbeat_naming(RUNNING_RELEASE))

    assert gate.is_passed() is False
    assert gate.is_overdue(STARTED_AT + GATE_SECONDS) is True
    assert gate.describe_failure() == (
        f"the server did not accept {NEW_RELEASE}'s hello in {GATE_SECONDS}s: "
        f"it still names {RUNNING_RELEASE}"
    )


def test_a_server_that_accepted_no_hello_does_not_pass_the_gate():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
    gate.note_heartbeat(heartbeat_naming(None))

    assert gate.is_passed() is False
    assert gate.describe_failure().endswith("it has accepted no hello from this node")


def test_a_heartbeat_sent_before_the_server_read_the_hello_does_not_spoil_a_later_one():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
    gate.note_heartbeat(heartbeat_naming(RUNNING_RELEASE))
    gate.note_heartbeat(heartbeat_naming(NEW_RELEASE))
    assert gate.is_passed() is True


def test_a_heartbeat_before_hello_does_not_pass_the_gate():
    gate = HealthGate(PENDING)
    gate.note_heartbeat(HEARTBEAT_FROM_A_1_1_SERVER)
    gate.note_hello(NEW_RELEASE)
    assert gate.is_passed() is False


def test_the_gate_is_overdue_only_once_its_time_is_up():
    gate = HealthGate(PENDING)
    gate.note_hello(NEW_RELEASE)
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


def test_a_prune_leaves_nothing_aside_and_a_start_sweeps_up_an_interrupted_one(tmp_path):
    layout = make_layout(tmp_path)
    for release in ("1.1.7", "1.1.8", "1.1.9", NEW_RELEASE):
        layout.locate_release(release).mkdir()
    oldest = os.path.getmtime(layout.locate_release(RUNNING_RELEASE)) - 1000
    os.utime(layout.locate_release("1.1.7"), (oldest, oldest))
    layout.switch_current_to(NEW_RELEASE)
    interrupted = layout.releases / ".pruning-1.0.0"
    interrupted.mkdir()

    assert set(layout.prune_releases(protected=set())) == {"1.1.7", RUNNING_RELEASE}
    assert not any(entry.name.startswith(".pruning-1.1") for entry in layout.releases.iterdir())
    assert layout.remove_unfinished_downloads() == [".pruning-1.0.0"]


def test_a_prune_does_not_wait_for_a_busy_switch_lock_when_told_not_to(tmp_path):
    layout = make_layout(tmp_path)

    with layout.hold_switch_lock(), pytest.raises(BlockingIOError):
        layout.prune_releases(protected=set(), should_wait=False)


def test_a_prune_never_removes_the_release_current_points_at(tmp_path):
    layout = make_layout(tmp_path)
    for release in ("1.1.7", "1.1.8", "1.1.9", NEW_RELEASE):
        layout.locate_release(release).mkdir()
    oldest = os.path.getmtime(layout.locate_release(RUNNING_RELEASE)) - 1000
    os.utime(layout.locate_release(RUNNING_RELEASE), (oldest, oldest))

    removed = layout.prune_releases(protected={NEW_RELEASE})

    assert RUNNING_RELEASE not in removed
    assert layout.locate_release(RUNNING_RELEASE).is_dir()


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
