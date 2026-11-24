"""Make a release that tools/deploy-agent-linux.sh copied the current one."""

from __future__ import annotations

import sys

from .release_layout import ReleaseLayout


def make_current(layout: ReleaseLayout, release: str) -> list[str]:
    previous_release = layout.read_current_release()
    layout.switch_current_to(release)
    # A hand deploy supersedes any update still waiting on its health gate.
    layout.clear_pending()
    protected = {release} | ({previous_release} if previous_release else set())
    return layout.prune_releases(protected)


def main(arguments: list[str]) -> int:
    layout = ReleaseLayout.from_environment()
    if layout is None or len(arguments) != 1:
        print("usage: TEMPESTAS_AGENT_HOME=<home> python -m tempestas_agent.hand_deploy <release>")
        return 2
    release = arguments[0]
    if not layout.release_path(release).is_dir():
        print(f"no release {release} under {layout.releases}")
        return 1
    for pruned in make_current(layout, release):
        print(f"pruned {pruned}")
    print(f"current is {release}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
