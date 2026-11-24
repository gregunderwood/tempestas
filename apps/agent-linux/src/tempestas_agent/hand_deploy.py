"""Make a release that tools/deploy-agent-linux.sh copied the current one."""

from __future__ import annotations

import sys

from . import contract
from .release_layout import ReleaseLayout, UpdateOutcome
from .update_gate import record_outcome

EXIT_DEPLOYED = 0
EXIT_NO_SUCH_RELEASE = 1
EXIT_USAGE = 2


def make_current(layout: ReleaseLayout, release: str) -> list[str]:
    with layout.hold_switch_lock():
        previous_release = layout.read_current_release()
        pending = layout.read_pending()
        layout.switch_current_to(release)
        if pending is not None:
            # The server is still waiting to hear how that update ended.
            record_outcome(
                layout,
                UpdateOutcome(
                    pending.command_id,
                    contract.UpdateState.FAILED,
                    f"replaced by a hand deploy of {release} before its health gate passed",
                ),
            )
        return layout.prune_releases({release, previous_release} - {None})


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
