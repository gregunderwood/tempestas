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
        self.hello_version: str | None = None
        self.has_server_accepted_hello = False
        self.has_heard_versions_named = False
        # One string, so the main loop never reads half of a refusal the MQTT thread is writing.
        self.last_refusal: str | None = None
        self.is_start_recorded = False
        self._watched_seconds = 0.0
        self._watching_since: float | None = None
        self._clock_lock = threading.Lock()

    @property
    def has_said_hello(self) -> bool:
        return self.hello_version is not None

    def note_hello(self, agent_version: str) -> None:
        self.hello_version = agent_version
        # A refusal answers an earlier hello, so it must not outlive a new one.
        self.last_refusal = None

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
        accepted_version_field = contract.HEARTBEAT_ACCEPTED_VERSION_FIELD
        if accepted_version_field in heartbeat:
            self.has_heard_versions_named = True
        # Before our hello, a heartbeat proves only the broker.
        if not self.has_said_hello:
            return
        if accepted_version_field in heartbeat:
            self._note_named_version(heartbeat[accepted_version_field])
        else:
            self._note_heartbeat_without_a_version()

    def _note_named_version(self, accepted_version: object) -> None:
        if accepted_version == self.hello_version:
            self.has_server_accepted_hello = True
        else:
            self.last_refusal = describe_what_server_accepted(accepted_version)

    def _note_heartbeat_without_a_version(self) -> None:
        # Only a pre-1.2 server omits the version, so once one was named this proves nothing.
        if self.has_heard_versions_named:
            self.last_refusal = "it stopped naming the version it accepted"
        else:
            self.has_server_accepted_hello = True

    def is_passed(self) -> bool:
        return self.has_server_accepted_hello

    def is_refused(self) -> bool:
        return not self.is_passed() and self.last_refusal is not None

    def is_overdue(self, now: float) -> bool:
        return not self.is_passed() and self.read_watched_seconds(now) >= GATE_SECONDS

    def describe_failure(self) -> str:
        version = self.pending.version
        refusal = self.last_refusal
        if refusal is None:
            return f"{version} heard no heartbeat in {GATE_SECONDS}s with the server online"
        return f"the server did not accept {version}'s hello in {GATE_SECONDS}s: {refusal}"


def describe_what_server_accepted(accepted_version: object) -> str:
    if accepted_version is None:
        return "it has accepted no hello from this node"
    if not isinstance(accepted_version, str) or not accepted_version:
        return f"it named {accepted_version!r}, which is not a version"
    return f"it still names {accepted_version}"


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


def roll_back_gate(layout: ReleaseLayout, gate: HealthGate, reason: str) -> UpdateOutcome:
    pending = gate.pending
    if not layout.locate_release(pending.previous_release).is_dir():
        # Better a failing release than `current` pointing at nothing.
        return record_outcome(
            layout,
            UpdateOutcome(
                pending.command_id,
                contract.UpdateState.FAILED,
                f"{reason}, and {pending.previous_release} to roll back to is missing, so it stays",
            ),
        )
    # Switched first, so a crash before the outcome reads as a failed start.
    layout.switch_current_to(pending.previous_release)
    return record_outcome(
        layout,
        UpdateOutcome(pending.command_id, contract.UpdateState.ROLLED_BACK, reason),
    )


def record_start(layout: ReleaseLayout, gate: HealthGate) -> None:
    layout.write_started(StartedUpdate(gate.pending.command_id))


def record_outcome(layout: ReleaseLayout, outcome: UpdateOutcome) -> UpdateOutcome:
    # Pending last, so a crash before it retries the whole step.
    layout.write_outcome(outcome)
    layout.clear_start_records()
    layout.clear_pending()
    return outcome
