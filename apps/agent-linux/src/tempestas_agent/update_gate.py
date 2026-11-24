"""After an update the new release proves itself, or puts the previous one back."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

from . import contract
from .release_layout import PendingUpdate, ReleaseLayout, StartedUpdate, UpdateOutcome

GATE_SECONDS = 120


@dataclass
class UpdateSettlement:
    gate: HealthGate | None = None
    outcome: UpdateOutcome | None = None
    should_restart: bool = False


class HealthGate:
    """Counts only time with the broker connected and the server online: an outage is no verdict."""

    def __init__(self, pending: PendingUpdate):
        self.pending = pending
        self.has_said_hello = False
        self.has_heard_heartbeat = False
        self.is_start_recorded = False
        self._watched_seconds = 0.0
        self._watching_since: float | None = None
        self._clock_lock = threading.Lock()

    def note_hello(self) -> None:
        self.has_said_hello = True

    def start_watching(self, now: float) -> None:
        with self._clock_lock:
            if self._watching_since is None:
                self._watching_since = now

    def stop_watching(self, now: float) -> None:
        with self._clock_lock:
            if self._watching_since is not None:
                self._watched_seconds += now - self._watching_since
                self._watching_since = None

    def read_watched_seconds(self, now: float) -> float:
        with self._clock_lock:
            running = 0.0 if self._watching_since is None else now - self._watching_since
            return self._watched_seconds + running

    def note_heartbeat(self) -> None:
        # A heartbeat before our hello proves the broker, not that the server knows this release.
        if self.has_said_hello:
            self.has_heard_heartbeat = True

    def is_passed(self) -> bool:
        return self.has_said_hello and self.has_heard_heartbeat

    def is_overdue(self, now: float) -> bool:
        return not self.is_passed() and self.read_watched_seconds(now) >= GATE_SECONDS

    def describe_failure(self) -> str:
        version = self.pending.version
        return f"{version} heard no heartbeat in {GATE_SECONDS}s with the server online"


def settle_update_on_start(
    layout: ReleaseLayout | None, loaded_release: Path | None = None
) -> UpdateSettlement:
    if layout is None:
        return UpdateSettlement()
    with layout.hold_switch_lock(should_wait=False):
        # Under the lock: a rollback switching after the check would leave this code running.
        if is_running_another_release(layout, loaded_release):
            return UpdateSettlement(should_restart=True)
        return settle_while_locked(layout)


def is_running_another_release(layout: ReleaseLayout, loaded_release: Path | None) -> bool:
    if loaded_release is None or loaded_release.parent != layout.releases.resolve():
        return False
    current_release = layout.read_current_release()
    return current_release is not None and current_release != loaded_release.name


def settle_while_locked(layout: ReleaseLayout) -> UpdateSettlement:
    settlement = UpdateSettlement(outcome=layout.read_outcome())
    pending = layout.read_pending()
    if pending is None:
        return settlement
    if is_already_settled(settlement.outcome, pending):
        # A crash between recording the outcome and clearing the pending record; finish it.
        record_outcome(layout, settlement.outcome)
        return settlement
    if layout.read_current_release() == pending.version:
        settlement.gate = HealthGate(pending)
        return settlement
    settlement.outcome = record_outcome(layout, describe_finished_rollback(layout, pending))
    return settlement


def is_already_settled(outcome: UpdateOutcome | None, pending: PendingUpdate) -> bool:
    return outcome is not None and outcome.command_id == pending.command_id


def describe_finished_rollback(layout: ReleaseLayout, pending: PendingUpdate) -> UpdateOutcome:
    recorded = layout.read_outcome()
    if recorded is not None and recorded.command_id == pending.command_id:
        return recorded
    started = layout.read_started()
    if started is not None and started.command_id == pending.command_id:
        what_happened = "kept failing after it started"
    else:
        what_happened = "did not start"
    return UpdateOutcome(
        pending.command_id,
        contract.UpdateState.ROLLED_BACK,
        f"{pending.version} {what_happened}, so {pending.previous_release} runs again",
    )


def is_still_pending(layout: ReleaseLayout, gate: HealthGate) -> bool:
    return layout.read_pending() == gate.pending


def is_still_current(layout: ReleaseLayout, gate: HealthGate) -> bool:
    return layout.read_current_release() == gate.pending.version


def pass_gate(layout: ReleaseLayout, gate: HealthGate) -> UpdateOutcome:
    # Recorded, not just published, so a lost publish or a crash still tells the server.
    return record_outcome(
        layout, UpdateOutcome(gate.pending.command_id, contract.UpdateState.HEALTHY)
    )


def prune_after_update(layout: ReleaseLayout, pending: PendingUpdate) -> list[str]:
    return layout.prune_releases(
        protected={pending.version, pending.previous_release}, should_wait=False
    )


def roll_back_gate(layout: ReleaseLayout, gate: HealthGate) -> UpdateOutcome:
    pending = gate.pending
    if not layout.locate_release(pending.previous_release).is_dir():
        # `current` pointing at nothing could never start again; a failing release at least runs.
        return record_outcome(
            layout,
            UpdateOutcome(
                pending.command_id,
                contract.UpdateState.FAILED,
                f"{gate.describe_failure()}, and {pending.previous_release} to roll back to"
                " is missing, so it stays",
            ),
        )
    # Switched first: a crash before the outcome is written reads as a failed start, which it was.
    layout.switch_current_to(pending.previous_release)
    return record_outcome(
        layout,
        UpdateOutcome(
            pending.command_id, contract.UpdateState.ROLLED_BACK, gate.describe_failure()
        ),
    )


def record_start(layout: ReleaseLayout, gate: HealthGate) -> None:
    layout.write_started(StartedUpdate(gate.pending.command_id))


def record_outcome(layout: ReleaseLayout, outcome: UpdateOutcome) -> UpdateOutcome:
    # The pending record goes last, so a crash before it still reports and retries the step.
    layout.write_outcome(outcome)
    layout.clear_start_records()
    layout.clear_pending()
    return outcome
