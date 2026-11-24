"""Make a release that tools/deploy-agent-linux.sh copied the current one."""

from __future__ import annotations

import sys

from . import contract
from .release_layout import PendingUpdate, ReleaseLayout, UpdateOutcome
from .update_gate import describe_finished_rollback, record_outcome

EXIT_DEPLOYED = 0
EXIT_NO_SUCH_RELEASE = 1
EXIT_USAGE = 2


def make_current(layout: ReleaseLayout, release: str) -> list[str]:
    with layout.hold_switch_lock():
        previous_release = layout.read_current_release()
        pending = layout.read_pending()
        # A redeploy of the gated version leaves the gate to judge it.
        is_replacing_an_update = pending is not None and not (
            release == pending.version == previous_release
        )
        if is_replacing_an_update:
            # Before the switch, so a crash between cannot read as a failed start.
            record_outcome(
                layout, describe_replaced_update(layout, pending, previous_release, release)
            )
        layout.switch_current_to(release)
    # Outside the lock, so a slow prune never blocks the agent.
    protected = {release, previous_release}
    is_gate_left_running = pending is not None and not is_replacing_an_update
    if is_gate_left_running:
        protected.add(pending.previous_release)
    return layout.prune_releases(protected - {None})


def describe_replaced_update(
    layout: ReleaseLayout, pending: PendingUpdate, running_release: str | None, release: str
) -> UpdateOutcome:
    if running_release != pending.version:
        # Already rolled back; the agent has not reported it yet.
        return describe_finished_rollback(layout, pending)
    return UpdateOutcome(
        pending.command_id,
        contract.UpdateState.FAILED,
        f"replaced by a hand deploy of {release} before its health gate passed",
    )


def main(arguments: list[str]) -> int:
    layout = ReleaseLayout.from_environment()
    if layout is None or len(arguments) != 1:
        print("usage: TEMPESTAS_AGENT_HOME=<home> python -m tempestas_agent.hand_deploy <release>")
        return EXIT_USAGE
    release = arguments[0]
    if not layout.locate_release(release).is_dir():
        print(f"no release {release} under {layout.releases}")
        return EXIT_NO_SUCH_RELEASE
    for pruned in make_current(layout, release):
        print(f"pruned {pruned}")
    print(f"current is {release}")
    return EXIT_DEPLOYED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
