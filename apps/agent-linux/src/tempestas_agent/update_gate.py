"""After an update the new release proves itself, or puts the previous one back."""

from __future__ import annotations

from dataclasses import dataclass

from . import contract
from .release_layout import PendingUpdate, ReleaseLayout, UpdateOutcome

GATE_SECONDS = 120


@dataclass
class UpdateSettlement:
    """What this start owes the server about an update: a gate to run, an outcome to report."""

    gate: HealthGate | None = None
    outcome: UpdateOutcome | None = None


class HealthGate:
    def __init__(self, pending: PendingUpdate, started_at: float):
        self.pending = pending
        self.deadline = started_at + GATE_SECONDS
        self.has_said_hello = False
        self.has_heard_heartbeat = False

    def note_hello(self) -> None:
        self.has_said_hello = True

    def note_heartbeat(self) -> None:
        # A heartbeat before our hello proves the broker, not that the server knows this release.
        if self.has_said_hello:
            self.has_heard_heartbeat = True

    def is_passed(self) -> bool:
        return self.has_said_hello and self.has_heard_heartbeat

    def is_overdue(self, now: float) -> bool:
        return not self.is_passed() and now >= self.deadline

    def describe_failure(self) -> str:
        missing = "hello" if not self.has_said_hello else "heartbeat"
        return f"{self.pending.version} sent no {missing} within {GATE_SECONDS}s"


def settle_update_on_start(layout: ReleaseLayout | None, now: float) -> UpdateSettlement:
    if layout is None:
        return UpdateSettlement()
    settlement = UpdateSettlement(outcome=layout.read_outcome())
    pending = layout.read_pending()
    if pending is None:
        return settlement
    if layout.read_current_release() == pending.version:
        settlement.gate = HealthGate(pending, now)
        return settlement
    # The rollback unit switched back because the new release could not even start.
    settlement.outcome = record_outcome(
        layout,
        UpdateOutcome(
            pending.command_id,
            contract.UpdateState.ROLLED_BACK,
            f"{pending.version} did not start, so {layout.read_current_release()} runs again",
        ),
    )
    return settlement


def pass_gate(layout: ReleaseLayout, gate: HealthGate) -> None:
    layout.clear_pending()
    layout.prune_releases(protected={gate.pending.version, gate.pending.previous_release})


def roll_back_gate(layout: ReleaseLayout, gate: HealthGate) -> None:
    pending = gate.pending
    # Switched first: a crash before the outcome is written reads as a failed start, which it was.
    layout.switch_current_to(pending.previous_release)
    record_outcome(
        layout,
        UpdateOutcome(
            pending.command_id, contract.UpdateState.ROLLED_BACK, gate.describe_failure()
        ),
    )


def record_outcome(layout: ReleaseLayout, outcome: UpdateOutcome) -> UpdateOutcome:
    # The outcome before the pending record goes, so a crash between them still reports.
    layout.write_outcome(outcome)
    layout.clear_pending()
    return outcome
