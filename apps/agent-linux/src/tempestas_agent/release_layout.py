"""Where releases live on a node, which one runs, and what an update in flight owes the server."""

from __future__ import annotations

import fcntl
import json
import logging
import os
import shutil
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

HOME_ENVIRONMENT_VARIABLE = "TEMPESTAS_AGENT_HOME"
RELEASES_DIRECTORY = "releases"
CURRENT_LINK = "current"
STATE_DIRECTORY = "update-state"
PENDING_FILE = "pending.json"
OUTCOME_FILE = "outcome.json"
# Read by the rollback script, which forgives a release that said hello a few failed runs.
STARTED_FILE = "started.json"
FAILED_RUNS_FILE = "failed-runs.json"
SWITCH_LOCK_FILE = "switch.lock"
# A release still arriving or being replaced: never run, and never counted as one to keep.
UNFINISHED_PREFIX = "."
# tools/deploy-agent-linux.sh stages here and cleans up itself, perhaps while the agent starts.
HAND_DEPLOY_STAGING_PREFIX = ".deploy-"
# Left behind only by an interrupted prune, so the start's sweep removes it like a download.
PRUNING_PREFIX = ".pruning-"
KEPT_RELEASES = 3

log = logging.getLogger("tempestas.agent")


@dataclass
class PendingUpdate:
    command_id: str
    version: str
    previous_release: str


@dataclass
class StartedUpdate:
    command_id: str


@dataclass
class UpdateOutcome:
    command_id: str
    state: str
    reason: str | None = None


class ReleaseLayout:
    def __init__(self, home: Path):
        self.home = home
        self.releases = home / RELEASES_DIRECTORY
        self.current_link = home / CURRENT_LINK
        self.state = home / STATE_DIRECTORY

    @classmethod
    def from_environment(cls) -> ReleaseLayout | None:
        home = os.environ.get(HOME_ENVIRONMENT_VARIABLE)
        return cls(Path(home)) if home else None

    @contextmanager
    def hold_switch_lock(self, should_wait: bool = True) -> Iterator[None]:
        """Around every read-then-switch of `current`; BlockingIOError if busy and not waiting."""
        self.state.mkdir(parents=True, exist_ok=True)
        with open(self.state / SWITCH_LOCK_FILE, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX if should_wait else fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield

    def read_current_release(self) -> str | None:
        try:
            return Path(os.readlink(self.current_link)).name
        except OSError:
            return None

    def read_current_link_identity(self) -> tuple[int, int]:
        """Changes with every switch, even back to the same release, as a hand deploy makes."""
        link = os.lstat(self.current_link)
        # The creation time too: a freed inode is often handed to the very next new link.
        return link.st_ino, link.st_ctime_ns

    def locate_release(self, release: str) -> Path:
        return self.releases / release

    def locate_unfinished_release(self, release: str) -> Path:
        return self.releases / f"{UNFINISHED_PREFIX}{release}"

    def switch_current_to(self, release: str) -> None:
        # A new link renamed over the old one, so `current` is never missing, even for a moment.
        staged_link = self.home / f"{UNFINISHED_PREFIX}{CURRENT_LINK}"
        staged_link.unlink(missing_ok=True)
        staged_link.symlink_to(Path(RELEASES_DIRECTORY) / release)
        os.replace(staged_link, self.current_link)
        sync_directory(self.home)

    def read_pending(self) -> PendingUpdate | None:
        return read_record(self.state / PENDING_FILE, PendingUpdate)

    def write_pending(self, pending: PendingUpdate) -> None:
        write_record(self.state / PENDING_FILE, pending)

    def clear_pending(self) -> None:
        (self.state / PENDING_FILE).unlink(missing_ok=True)

    def write_started(self, started: StartedUpdate) -> None:
        write_record(self.state / STARTED_FILE, started)

    def read_started(self) -> StartedUpdate | None:
        return read_record(self.state / STARTED_FILE, StartedUpdate)

    def clear_start_records(self) -> None:
        (self.state / STARTED_FILE).unlink(missing_ok=True)
        (self.state / FAILED_RUNS_FILE).unlink(missing_ok=True)

    def read_outcome(self) -> UpdateOutcome | None:
        return read_record(self.state / OUTCOME_FILE, UpdateOutcome)

    def write_outcome(self, outcome: UpdateOutcome) -> None:
        write_record(self.state / OUTCOME_FILE, outcome)

    def clear_outcome(self) -> None:
        (self.state / OUTCOME_FILE).unlink(missing_ok=True)

    def prune_releases(self, protected: set[str], should_wait: bool = True) -> list[str]:
        # Chosen and moved aside under the lock, so no switch can make one current meanwhile.
        with self.hold_switch_lock(should_wait=should_wait):
            removed = self._choose_releases_to_prune(protected)
            doomed = [self._move_aside_for_pruning(release) for release in removed]
        # Deleted outside it: removing trees on a slow card must not hold up a switch.
        for path in doomed:
            shutil.rmtree(path, ignore_errors=True)
        return removed

    def _choose_releases_to_prune(self, protected: set[str]) -> list[str]:
        finished = [
            entry
            for entry in self.releases.iterdir()
            if entry.is_dir() and not entry.name.startswith(UNFINISHED_PREFIX)
        ]
        newest_first = sorted(finished, key=read_modified_time, reverse=True)
        kept = {entry.name for entry in newest_first[:KEPT_RELEASES]} | protected
        kept.add(self.read_current_release())
        return [entry.name for entry in newest_first if entry.name not in kept]

    def _move_aside_for_pruning(self, release: str) -> Path:
        aside = self.releases / f"{PRUNING_PREFIX}{release}"
        shutil.rmtree(aside, ignore_errors=True)
        self.locate_release(release).rename(aside)
        return aside

    def remove_unfinished_downloads(self) -> list[str]:
        """Only at start: a download cut off by a restart leaves its staging behind for good."""
        unfinished = [entry for entry in self.releases.iterdir() if is_unfinished_download(entry)]
        for entry in unfinished:
            shutil.rmtree(entry, ignore_errors=True)
        return [entry.name for entry in unfinished]


def is_unfinished_download(entry: Path) -> bool:
    name = entry.name
    return (
        entry.is_dir()
        and name.startswith(UNFINISHED_PREFIX)
        and not name.startswith(HAND_DEPLOY_STAGING_PREFIX)
    )


def read_modified_time(entry: Path) -> float:
    try:
        return entry.stat().st_mtime
    except FileNotFoundError:
        return 0.0


def read_record(path: Path, record_type):
    try:
        return record_type(**json.loads(path.read_text()))
    except FileNotFoundError:
        return None
    except (ValueError, TypeError, UnicodeDecodeError) as error:
        # A record that cannot be read must never keep the agent from starting.
        log.error("dropped unreadable %s: %s", path, error)
        path.unlink(missing_ok=True)
        return None


def write_record(path: Path, record) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(f"{UNFINISHED_PREFIX}{path.name}")
    with staged.open("w") as staged_file:
        staged_file.write(json.dumps(asdict(record)))
        staged_file.flush()
        os.fsync(staged_file.fileno())
    os.replace(staged, path)
    sync_directory(path.parent)


def sync_directory(directory: Path) -> None:
    # Without it a power cut can undo a rename that already returned.
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
