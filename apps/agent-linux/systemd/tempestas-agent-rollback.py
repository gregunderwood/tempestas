"""Put the previous release back when an updated agent cannot start; see docs/Infrastructure."""

# Standalone: it runs when the release it rolls back from is broken, so it imports none of it.

import json
import os
import sys
from pathlib import Path

EXIT_ROLLED_BACK = 0
EXIT_NOTHING_TO_ROLL_BACK = 1
# The release layout's names, repeated here because this script imports nothing from a release.
HOME_ENVIRONMENT_VARIABLE = "TEMPESTAS_AGENT_HOME"
RELEASES_DIRECTORY = "releases"
CURRENT_LINK = "current"
STAGED_CURRENT_LINK = ".current"
PENDING_RECORD = Path("update-state") / "pending.json"


def main() -> int:
    home = Path(os.environ[HOME_ENVIRONMENT_VARIABLE])
    current_link = home / CURRENT_LINK
    try:
        pending = json.loads((home / PENDING_RECORD).read_text())
        pending_version, previous_release = pending["version"], pending["previous_release"]
    except FileNotFoundError:
        print("no update is pending, so the agent failed for another reason")
        return EXIT_NOTHING_TO_ROLL_BACK
    except (ValueError, KeyError, TypeError) as error:
        print(f"pending.json cannot be read ({error}), so nothing is rolled back")
        return EXIT_NOTHING_TO_ROLL_BACK
    try:
        running_release = Path(os.readlink(current_link)).name
    except OSError as error:
        print(f"{current_link} is not a release link ({error}), so nothing is rolled back")
        return EXIT_NOTHING_TO_ROLL_BACK
    if running_release != pending_version:
        print(f"{running_release} is not the pending update, so it stays")
        return EXIT_NOTHING_TO_ROLL_BACK

    staged_link = home / STAGED_CURRENT_LINK
    staged_link.unlink(missing_ok=True)
    staged_link.symlink_to(Path(RELEASES_DIRECTORY) / previous_release)
    os.replace(staged_link, current_link)
    sync_directory(home)
    # pending.json stays: the previous release reads it on start and reports the rollback.
    print(f"{pending_version} did not start; switched back to {previous_release}")
    return EXIT_ROLLED_BACK


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    sys.exit(main())
