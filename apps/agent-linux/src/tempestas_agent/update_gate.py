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
    """Counts only time with the server online: an outage is no verdict."""

    def __init__(self, pending: PendingUpdate):
        self.pending = pending
        self.has_said_hello = False
        self.has_heard_heartbeat = False
        self.hello_version: str | None = None
        self.has_heard_another_accepted_version = False
        self.server_accepted_version: str | None = None
        self.is_start_recorded = False
        self._watched_seconds = 0.0
        self._watching_since: float | None = None
        self._clock_lock = threading.Lock()

    def note_hello(self, agent_version: str) -> None:
        self.has_said_hello = True
        self.hello_version = agent_version

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

    def note_heartbeat(self, heartbeat: dict) -> None:
        # Before our hello, a heartbeat proves only the broker.
        if not self.has_said_hello:
            return
        if self._has_server_accepted_our_hello(heartbeat):
            self.has_heard_heartbeat = True
        else:
            self.has_heard_another_accepted_version = True
            self.server_accepted_version = heartbeat[contract.HEARTBEAT_ACCEPTED_VERSION]

    def _has_server_accepted_our_hello(self, heartbeat: dict) -> bool:
        # A server before contract 1.2 names no version, so any heartbeat is all it can show.
        if contract.HEARTBEAT_ACCEPTED_VERSION not in heartbeat:
            return True
        return heartbeat[contract.HEARTBEAT_ACCEPTED_VERSION] == self.hello_version

    def is_passed(self) -> bool:
        return self.has_said_hello and self.has_heard_heartbeat

    def is_overdue(self, now: float) -> bool:
        return not self.is_passed() and self.read_watched_seconds(now) >= GATE_SECONDS

    def describe_failure(self) -> str:
        version = self.pending.version
        if self.has_heard_another_accepted_version:
            refusal = f"the server did not accept {version}'s hello in {GATE_SECONDS}s"
            return f"{refusal}: {self._describe_what_server_accepted()}"
        return f"{version} heard no heartbeat in {GATE_SECONDS}s with the server online"

    def _describe_what_server_accepted(self) -> str:
        if self.server_accepted_version is None:
            return "it has accepted no hello from this node"
        return f"it still names {self.server_accepted_version}"


def settle_update_on_start(
    layout: ReleaseLayout | None, loaded_release: Path | None = None
) -> UpdateSettlement:
    if layout is None:
        return UpdateSettlement()
    with layout.hold_switch_lock(should_wait=False):
        # Under the lock, so a rollback cannot slip in after the check.
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
        # A crash came between recording the outcome and clearing pending.
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
    # Recorded, so a lost publish or a crash still reports it.
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
        # Better a failing release than `current` pointing at nothing.
        return record_outcome(
            layout,
            UpdateOutcome(
                pending.command_id,
                contract.UpdateState.FAILED,
                f"{gate.describe_failure()}, and {pending.previous_release} to roll back to"
                " is missing, so it stays",
            ),
        )
    # Switched first, so a crash before the outcome reads as a failed start.
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
    # Pending last, so a crash before it retries the whole step.
    layout.write_outcome(outcome)
    layout.clear_start_records()
    layout.clear_pending()
    return outcome
