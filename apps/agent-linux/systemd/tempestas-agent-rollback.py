"""Put the previous release back when an updated agent cannot start; see docs/Infrastructure."""

# Standalone: it runs when the release it rolls back from is broken, so it imports none of it.

import json
import os
import sys
from pathlib import Path

EXIT_ROLLED_BACK = 0
EXIT_NOTHING_TO_ROLL_BACK = 1


def main() -> int:
    home = Path(os.environ["TEMPESTAS_AGENT_HOME"])
    current_link = home / "current"
    try:
        pending = json.loads((home / "update-state" / "pending.json").read_text())
    except FileNotFoundError:
        print("no update is pending, so the agent failed for another reason")
        return EXIT_NOTHING_TO_ROLL_BACK
    running_release = Path(os.readlink(current_link)).name
    if running_release != pending["version"]:
        print(f"{running_release} is not the pending update, so it stays")
        return EXIT_NOTHING_TO_ROLL_BACK

    previous_release = pending["previous_release"]
    staged_link = home / ".current"
    staged_link.unlink(missing_ok=True)
    staged_link.symlink_to(Path("releases") / previous_release)
    os.replace(staged_link, current_link)
    # pending.json stays: the previous release reads it on start and reports the rollback.
    print(f"{pending['version']} did not start; switched back to {previous_release}")
    return EXIT_ROLLED_BACK


if __name__ == "__main__":
    sys.exit(main())
