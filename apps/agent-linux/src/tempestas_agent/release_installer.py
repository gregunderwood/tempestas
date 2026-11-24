"""Install a release beside the running one, so nothing changes until every byte is verified."""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import urllib.request
from collections.abc import Callable
from pathlib import Path
from urllib.parse import quote, urljoin

from . import contract
from .release_layout import PendingUpdate, ReleaseLayout
from .update_command import SHA256_HEX
from .version import AGENT_NAME

log = logging.getLogger("tempestas.agent")

BUNDLE_FILES_DIRECTORY = "files"
DEPENDENCY_LOCK = "uv.lock"
FETCH_TIMEOUT_S = 30
MAX_FILE_BYTES = 20 * 1024 * 1024


class UpdateFailed(Exception):
    """Why an update went nowhere; the node still runs what it ran before."""


def fetch_over_http(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=FETCH_TIMEOUT_S) as response:
            body = response.read(MAX_FILE_BYTES + 1)
    except OSError as error:
        raise UpdateFailed(f"could not fetch {url}: {error}") from error
    if len(body) > MAX_FILE_BYTES:
        raise UpdateFailed(f"{url} is larger than {MAX_FILE_BYTES} bytes")
    return body


class ReleaseInstaller:
    def __init__(self, layout: ReleaseLayout, fetch: Callable[[str], bytes] = fetch_over_http):
        self.layout = layout
        self.fetch = fetch

    def install(self, command: dict, report: Callable[[str], None]) -> PendingUpdate:
        """Leaves the new release current and pending its health gate, or raises UpdateFailed."""
        version = command["version"]
        running_release = self._require_running_release(version)
        staging = self.layout.unfinished_path(version)
        try:
            report(contract.UpdateState.DOWNLOADING)
            manifest = self._fetch_verified_manifest(command)
            self._download_files(command["manifestUrl"], manifest["files"], staging)
            report(contract.UpdateState.VERIFYING)
            verify_files(manifest["files"], staging)
            self._require_same_dependencies(manifest["files"], running_release)
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        report(contract.UpdateState.INSTALLING)
        return self._switch_to(staging, command, running_release)

    def _require_running_release(self, version: str) -> str:
        running_release = self.layout.read_current_release()
        if running_release is None:
            raise UpdateFailed("this node does not run from a release, so it cannot update itself")
        if running_release == version:
            raise UpdateFailed(f"this node already runs {version}")
        return running_release

    def _fetch_verified_manifest(self, command: dict) -> dict:
        manifest_bytes = self.fetch(command["manifestUrl"])
        if hash_sha256(manifest_bytes) != command["manifestSha256"]:
            raise UpdateFailed("the manifest does not match the manifestSha256 in the command")
        manifest = parse_manifest(manifest_bytes)
        problem = describe_manifest_problem(manifest, command["version"])
        if problem is not None:
            raise UpdateFailed(problem)
        return manifest

    def _download_files(self, manifest_url: str, files: list[dict], staging: Path) -> None:
        shutil.rmtree(staging, ignore_errors=True)
        for listed_file in files:
            path = listed_file["path"]
            destination = staging / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(self.fetch(build_file_url(manifest_url, path)))

    def _require_same_dependencies(self, files: list[dict], running_release: str) -> None:
        running_lock = self.layout.release_path(running_release) / DEPENDENCY_LOCK
        listed_lock = next((file for file in files if file["path"] == DEPENDENCY_LOCK), None)
        if listed_lock is None:
            raise UpdateFailed(f"the bundle has no {DEPENDENCY_LOCK}")
        if not running_lock.exists() or hash_file(running_lock) != listed_lock["sha256"]:
            raise UpdateFailed(
                "its dependencies differ from this node's, so it needs tools/deploy-agent-linux.sh"
            )

    def _switch_to(self, staging: Path, command: dict, running_release: str) -> PendingUpdate:
        version = command["version"]
        destination = self.layout.release_path(version)
        shutil.rmtree(destination, ignore_errors=True)
        staging.rename(destination)
        pending = PendingUpdate(command["id"], version, running_release)
        try:
            # Before the switch: a crash between the two reads as a failed start, never as none.
            self.layout.write_pending(pending)
            self.layout.clear_outcome()
            self.layout.switch_current_to(version)
        except BaseException:
            self._abandon_switch(destination, running_release)
            raise
        return pending

    def _abandon_switch(self, destination: Path, running_release: str) -> None:
        """Reported as failed, so it must not also read as a rollback, or keep a release slot."""
        try:
            self.layout.switch_current_to(running_release)
            self.layout.clear_pending()
        except OSError as error:
            # The error that stopped the switch is the one worth raising, so this one is logged.
            log.error("could not undo the switch to %s: %s", destination.name, error)
            return
        shutil.rmtree(destination, ignore_errors=True)


def parse_manifest(manifest_bytes: bytes) -> dict:
    try:
        manifest = json.loads(manifest_bytes)
    except (ValueError, UnicodeDecodeError) as error:
        raise UpdateFailed("the manifest is not JSON") from error
    if not isinstance(manifest, dict):
        raise UpdateFailed("the manifest is not a JSON object")
    return manifest


def describe_manifest_problem(manifest: dict, version: str) -> str | None:
    if manifest.get("app") != AGENT_NAME:
        return f"the manifest is for {json.dumps(manifest.get('app'))}, not {AGENT_NAME}"
    if manifest.get("version") != version:
        return f"the manifest is for {json.dumps(manifest.get('version'))}, not {version}"
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return "the manifest lists no files"
    for listed_file in files:
        if not is_listed_file_well_formed(listed_file):
            return f"the manifest lists {json.dumps(listed_file)}, not a safe path with a sha256"
    return None


def is_listed_file_well_formed(listed_file) -> bool:
    if not isinstance(listed_file, dict):
        return False
    sha256 = listed_file.get("sha256")
    return (
        isinstance(sha256, str)
        and SHA256_HEX.fullmatch(sha256) is not None
        and is_safe_relative_path(listed_file.get("path"))
    )


# Written under the release by name, so a path must stay inside it.
def is_safe_relative_path(path) -> bool:
    if not isinstance(path, str) or "\\" in path:
        return False
    return all(segment not in ("", ".", "..") for segment in path.split("/"))


def verify_files(files: list[dict], staging: Path) -> None:
    for listed_file in files:
        if hash_file(staging / listed_file["path"]) != listed_file["sha256"]:
            raise UpdateFailed(f"{listed_file['path']} does not have the sha256 the manifest gives")


def build_file_url(manifest_url: str, path: str) -> str:
    return urljoin(manifest_url, f"{BUNDLE_FILES_DIRECTORY}/{quote(path)}")


def hash_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    return hash_sha256(path.read_bytes())
