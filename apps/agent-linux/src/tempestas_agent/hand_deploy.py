"""Make a release that tools/deploy-agent-linux.sh copied the current one."""

from __future__ import annotations

import sys

from .release_layout import ReleaseLayout

EXIT_DEPLOYED = 0
EXIT_NO_SUCH_RELEASE = 1
EXIT_USAGE = 2


def make_current(layout: ReleaseLayout, release: str) -> list[str]:
    previous_release = layout.read_current_release()
    pending = layout.read_pending()
    layout.switch_current_to(release)
    # A hand deploy supersedes any update still waiting on its health gate.
    layout.clear_pending()
    # The running agent may still roll its gate back before the deploy restarts it.
    protected = {release, previous_release, pending.previous_release if pending else None}
    return layout.prune_releases(protected - {None})


def main(arguments: list[str]) -> int:
    layout = ReleaseLayout.from_environment()
    if layout is None or len(arguments) != 1:
        print("usage: TEMPESTAS_AGENT_HOME=<home> python -m tempestas_agent.hand_deploy <release>")
        return EXIT_USAGE
    release = arguments[0]
    if not layout.release_path(release).is_dir():
        print(f"no release {release} under {layout.releases}")
        return EXIT_NO_SUCH_RELEASE
    for pruned in make_current(layout, release):
        print(f"pruned {pruned}")
    print(f"current is {release}")
    return EXIT_DEPLOYED


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
