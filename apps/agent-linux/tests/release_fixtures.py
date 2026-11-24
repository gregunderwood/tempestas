"""A node's release layout and a server's bundle, built in a temporary directory."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from tempestas_agent.release_layout import ReleaseLayout

RUNNING_RELEASE = "1.1.3"
NEW_RELEASE = "1.1.4"
LOCK = b"version = 1\n"
MANIFEST_URL = f"http://elantris:7000/api/agent-releases/agent-linux/{NEW_RELEASE}/manifest.json"
BUNDLE_FILES = {
    "uv.lock": LOCK,
    "pyproject.toml": b'[project]\nname = "tempestas-agent"\n',
    "src/tempestas_agent/deployed_version.py": f'AGENT_VERSION = "{NEW_RELEASE}"\n'.encode(),
}


def make_layout(home: Path, running: str = RUNNING_RELEASE, lock: bytes = LOCK) -> ReleaseLayout:
    layout = ReleaseLayout(home)
    release = layout.release_path(running)
    release.mkdir(parents=True)
    (release / "uv.lock").write_bytes(lock)
    layout.switch_current_to(running)
    return layout


def hash_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_manifest(version: str = NEW_RELEASE, files: dict[str, bytes] = BUNDLE_FILES) -> bytes:
    return json.dumps(
        {
            "app": "agent-linux",
            "version": version,
            "contractMajor": 1,
            "contractMinor": 1,
            "files": [{"path": path, "sha256": hash_sha256(data)} for path, data in files.items()],
        }
    ).encode()


class FakeServer:
    """Serves a bundle by URL, as the server's agent-release routes do."""

    def __init__(self, manifest: bytes | None = None, files: dict[str, bytes] = BUNDLE_FILES):
        self.manifest = manifest if manifest is not None else build_manifest(files=files)
        self.files = dict(files)
        self.fetched: list[str] = []

    def fetch(self, url: str) -> bytes:
        self.fetched.append(url)
        if url == MANIFEST_URL:
            return self.manifest
        return self.files[url.removeprefix(MANIFEST_URL.removesuffix("manifest.json") + "files/")]


def build_update_command(manifest: bytes, **overrides) -> dict:
    command = {
        "id": "update-1",
        "version": NEW_RELEASE,
        "manifestUrl": MANIFEST_URL,
        "manifestSha256": hash_sha256(manifest),
    }
    command.update(overrides)
    return command
