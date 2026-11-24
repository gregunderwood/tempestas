"""Where releases live on a node, which one runs, and what an update in flight owes the server."""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path

HOME_ENVIRONMENT_VARIABLE = "TEMPESTAS_AGENT_HOME"
RELEASES_DIRECTORY = "releases"
CURRENT_LINK = "current"
STATE_DIRECTORY = "update-state"
PENDING_FILE = "pending.json"
OUTCOME_FILE = "outcome.json"
# A release still arriving or being replaced: never run, and never counted as one to keep.
UNFINISHED_PREFIX = "."
KEPT_RELEASES = 3


@dataclass
class PendingUpdate:
    command_id: str
    version: str
    previous_release: str


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

    def read_current_release(self) -> str | None:
        try:
            return Path(os.readlink(self.current_link)).name
        except OSError:
            return None

    def release_path(self, release: str) -> Path:
        return self.releases / release

    def unfinished_path(self, release: str) -> Path:
        return self.releases / f"{UNFINISHED_PREFIX}{release}"

    def switch_current_to(self, release: str) -> None:
        # A new link renamed over the old one, so `current` is never missing, even for a moment.
        staged_link = self.home / f"{UNFINISHED_PREFIX}{CURRENT_LINK}"
        staged_link.unlink(missing_ok=True)
        staged_link.symlink_to(Path(RELEASES_DIRECTORY) / release)
        os.replace(staged_link, self.current_link)

    def read_pending(self) -> PendingUpdate | None:
        return read_record(self.state / PENDING_FILE, PendingUpdate)

    def write_pending(self, pending: PendingUpdate) -> None:
        write_record(self.state / PENDING_FILE, pending)

    def clear_pending(self) -> None:
        (self.state / PENDING_FILE).unlink(missing_ok=True)

    def read_outcome(self) -> UpdateOutcome | None:
        return read_record(self.state / OUTCOME_FILE, UpdateOutcome)

    def write_outcome(self, outcome: UpdateOutcome) -> None:
        write_record(self.state / OUTCOME_FILE, outcome)

    def clear_outcome(self) -> None:
        (self.state / OUTCOME_FILE).unlink(missing_ok=True)

    def prune_releases(self, protected: set[str]) -> list[str]:
        finished = [
            entry
            for entry in self.releases.iterdir()
            if entry.is_dir() and not entry.name.startswith(UNFINISHED_PREFIX)
        ]
        newest_first = sorted(finished, key=lambda entry: entry.stat().st_mtime, reverse=True)
        kept = {entry.name for entry in newest_first[:KEPT_RELEASES]} | protected
        removed = [entry.name for entry in newest_first if entry.name not in kept]
        for release in removed:
            shutil.rmtree(self.release_path(release))
        return removed


def read_record(path: Path, record_type):
    try:
        return record_type(**json.loads(path.read_text()))
    except FileNotFoundError:
        return None


def write_record(path: Path, record) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_name(f"{UNFINISHED_PREFIX}{path.name}")
    staged.write_text(json.dumps(asdict(record)))
    os.replace(staged, path)
