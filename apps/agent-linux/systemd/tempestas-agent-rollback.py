"""Put the previous release back when an updated agent cannot start; see docs/Infrastructure."""

# Standalone: it runs when the release it rolls back from is broken, so it imports none of it.

import fcntl
import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

EXIT_ROLLED_BACK = 0
EXIT_NOTHING_TO_ROLL_BACK = 1
# Run as ExecCondition, where 1-254 quietly skips the unit; 255 marks it failed, as it should.
EXIT_ROLLBACK_FAILED = 255
# The release layout's names, repeated here because this script imports nothing from a release.
HOME_ENVIRONMENT_VARIABLE = "TEMPESTAS_AGENT_HOME"
RELEASES_DIRECTORY = "releases"
CURRENT_LINK = "current"
STAGED_CURRENT_LINK = ".current"
STATE_DIRECTORY = "update-state"
PENDING_FILE = "pending.json"
SWITCH_LOCK_FILE = "switch.lock"


def main() -> int:
    try:
        home = Path(os.environ[HOME_ENVIRONMENT_VARIABLE])
        with hold_switch_lock(home):
            return roll_back_a_pending_update(home)
    except Exception as error:  # noqa: BLE001 - any failure here must fail the unit, not skip it
        print(f"rollback failed: {error!r}")
        return EXIT_ROLLBACK_FAILED


def roll_back_a_pending_update(home: Path) -> int:
    current_link = home / CURRENT_LINK
    try:
        pending = json.loads((home / STATE_DIRECTORY / PENDING_FILE).read_text())
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

    switch_current_to(home, previous_release)
    # pending.json stays: the previous release reads it on start and reports the rollback.
    print(f"{pending_version} did not start; switched back to {previous_release}")
    return EXIT_ROLLED_BACK


@contextmanager
def hold_switch_lock(home: Path) -> Iterator[None]:
    """The lock the agent and a hand deploy hold around every switch of `current`."""
    lock_path = home / STATE_DIRECTORY / SWITCH_LOCK_FILE
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield


def switch_current_to(home: Path, release: str) -> None:
    staged_link = home / STAGED_CURRENT_LINK
    staged_link.unlink(missing_ok=True)
    staged_link.symlink_to(Path(RELEASES_DIRECTORY) / release)
    os.replace(staged_link, home / CURRENT_LINK)
    sync_directory(home)


def sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    sys.exit(main())
