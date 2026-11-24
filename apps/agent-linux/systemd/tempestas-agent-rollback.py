"""Put the previous release back when an updated agent cannot start; see docs/Infrastructure."""

# Imports nothing from a release: the release may be what is broken.

import fcntl
import json
import os
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

EXIT_ROLLED_BACK = 0
EXIT_NOTHING_TO_ROLL_BACK = 1
# As ExecCondition, 1-254 skips the unit and 255 fails it.
EXIT_ROLLBACK_FAILED = 255
HOME_ENVIRONMENT_VARIABLE = "TEMPESTAS_AGENT_HOME"
RELEASES_DIRECTORY = "releases"
CURRENT_LINK = "current"
STAGED_CURRENT_LINK = ".current"
STATE_DIRECTORY = "update-state"
PENDING_FILE = "pending.json"
STARTED_FILE = "started.json"
FAILED_RUNS_FILE = "failed-runs.json"
SWITCH_LOCK_FILE = "switch.lock"
# A release that said hello is forgiven a few crashes, such as I2C after a reboot.
FAILED_RUNS_BEFORE_ROLLBACK = 3


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
        command_id = pending["command_id"]
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
    if has_said_hello(home, command_id):
        failed_runs = count_failed_run(home, command_id)
        if failed_runs < FAILED_RUNS_BEFORE_ROLLBACK:
            print(
                f"{pending_version} said hello before; failed run {failed_runs}, so it runs again"
            )
            return EXIT_NOTHING_TO_ROLL_BACK

    switch_current_to(home, previous_release)
    # pending.json stays: the previous release reports the rollback from it.
    print(f"{pending_version} did not start; switched back to {previous_release}")
    return EXIT_ROLLED_BACK


def has_said_hello(home: Path, command_id: str) -> bool:
    started = read_record(home / STATE_DIRECTORY / STARTED_FILE)
    return started.get("command_id") == command_id


def count_failed_run(home: Path, command_id: str) -> int:
    path = home / STATE_DIRECTORY / FAILED_RUNS_FILE
    record = read_record(path)
    earlier_runs = record.get("count", 0) if record.get("command_id") == command_id else 0
    failed_runs = (earlier_runs if isinstance(earlier_runs, int) else 0) + 1
    write_record(path, {"command_id": command_id, "count": failed_runs})
    return failed_runs


def write_record(path: Path, record: dict) -> None:
    # Atomic and synced, so a power cut cannot reset the count.
    staged = path.with_name(f".{path.name}.staged")
    with open(staged, "w") as staged_file:
        staged_file.write(json.dumps(record))
        staged_file.flush()
        os.fsync(staged_file.fileno())
    os.replace(staged, path)
    sync_directory(path.parent)


def read_record(path: Path) -> dict:
    try:
        record = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}
    return record if isinstance(record, dict) else {}


@contextmanager
def hold_switch_lock(home: Path) -> Iterator[None]:
    lock_path = home / STATE_DIRECTORY / SWITCH_LOCK_FILE
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with open(lock_path, "w") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        yield


def switch_current_to(home: Path, release: str) -> None:
    # Never point `current` at nothing: nothing would roll that back.
    if not (home / RELEASES_DIRECTORY / release).is_dir():
        raise FileNotFoundError(f"release {release} is missing, so `current` stays put")
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
