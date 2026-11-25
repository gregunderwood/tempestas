import hashlib
import json

import pytest

from http_fetch import FetchFailed
from slot_installer import (
    FREE_FLASH_MARGIN_BYTES,
    ROOT_ONLY_FILES,
    SlotInstaller,
    UpdateFailed,
    build_file_url,
)
from slots import SlotStore

RUNNING_VERSION = "1.2.0"
NEW_VERSION = "1.2.1"
BUNDLE_URL = "http://elantris:7000/api/agent-releases/agent-micropython/" + NEW_VERSION
MANIFEST_URL = BUNDLE_URL + "/manifest.json"
BUNDLE_FILES = {
    "node_runtime.py": b"def run():\n    pass\n",
    "deployed_version.py": b'AGENT_VERSION = "1.2.1"\n',
    "boards/pico_w.py": b"# the pico w\n",
    "boards/esp32.py": b"# another board\n",
}


def hash_sha256(content):
    return hashlib.sha256(content).hexdigest()


def build_manifest(files=None, **overrides):
    files = BUNDLE_FILES if files is None else files
    manifest = {
        "app": "agent-micropython",
        "version": NEW_VERSION,
        "contractMajor": 1,
        "contractMinor": 2,
        "files": [{"path": path, "sha256": hash_sha256(content)} for path, content in sorted(files.items())],
    }
    manifest.update(overrides)
    return json.dumps(manifest).encode()


class FakeFetcher:
    def __init__(self, bodies_by_url):
        self.bodies_by_url = bodies_by_url
        self.fetched_urls = []

    def fetch(self, url, write_chunk, max_bytes):
        self.fetched_urls.append(url)
        if url not in self.bodies_by_url:
            raise FetchFailed("%s answered 404" % url)
        write_chunk(self.bodies_by_url[url])


def serve_bundle(manifest_bytes=None, files=None):
    manifest_bytes = build_manifest() if manifest_bytes is None else manifest_bytes
    files = BUNDLE_FILES if files is None else files
    bodies = {MANIFEST_URL: manifest_bytes}
    for path, content in files.items():
        bodies[BUNDLE_URL + "/files/" + path] = content
    return FakeFetcher(bodies)


def build_command(manifest_bytes=None, version=NEW_VERSION):
    manifest_bytes = build_manifest() if manifest_bytes is None else manifest_bytes
    return {
        "id": "update-1",
        "version": version,
        "manifestUrl": MANIFEST_URL,
        "manifestSha256": hash_sha256(manifest_bytes),
    }


class Install:
    def __init__(self, root, fetcher):
        self.root = root
        self.store = SlotStore(str(root))
        self.store.write({"active": "a", "pending": None, "outcome": None})
        (root / "a").mkdir()
        (root / "a" / "node_runtime.py").write_bytes(b"# the running release\n")
        self.installer = SlotInstaller(self.store, fetcher, "pico_w", RUNNING_VERSION)
        self.reported = []

    def __call__(self, command):
        return self.installer.install(command, self.reported.append)


def test_fills_the_other_slot_and_marks_it_pending(tmp_path):
    install = Install(tmp_path, serve_bundle())

    assert install(build_command()) == "b"

    assert (tmp_path / "b" / "node_runtime.py").read_bytes() == BUNDLE_FILES["node_runtime.py"]
    assert (tmp_path / "b" / "boards" / "esp32.py").exists()
    assert install.reported == ["downloading", "verifying", "installing"]
    assert install.store.read()["pending"] == {
        "slot": "b",
        "commandId": "update-1",
        "version": NEW_VERSION,
        "attempts": 0,
    }


def test_installs_this_nodes_own_board_file_as_board_py(tmp_path):
    install = Install(tmp_path, serve_bundle())
    install(build_command())
    assert (tmp_path / "b" / "board.py").read_bytes() == BUNDLE_FILES["boards/pico_w.py"]


def test_leaves_the_running_slot_untouched(tmp_path):
    install = Install(tmp_path, serve_bundle())
    install(build_command())
    assert (tmp_path / "a" / "node_runtime.py").read_bytes() == b"# the running release\n"
    assert install.store.read()["active"] == "a"


def test_clears_whatever_an_earlier_update_left_in_the_other_slot(tmp_path):
    install = Install(tmp_path, serve_bundle())
    (tmp_path / "b").mkdir()
    (tmp_path / "b" / "leftover.py").write_bytes(b"stale")

    install(build_command())

    assert not (tmp_path / "b" / "leftover.py").exists()


def fail_install(install, command):
    with pytest.raises(UpdateFailed) as failure:
        install(command)
    assert install.store.read()["pending"] is None
    return str(failure.value)


def test_refuses_a_manifest_that_does_not_match_the_pinned_hash(tmp_path):
    install = Install(tmp_path, serve_bundle())
    command = build_command()
    command["manifestSha256"] = "0" * 64
    assert "does not match the manifestSha256" in fail_install(install, command)


def test_refuses_a_file_that_does_not_match_its_manifest_and_clears_the_slot(tmp_path):
    tampered = dict(BUNDLE_FILES, **{"node_runtime.py": b"import evil\n"})
    install = Install(tmp_path, serve_bundle(files=tampered))

    reason = fail_install(install, build_command())

    assert reason == "node_runtime.py does not have the sha256 the manifest gives"
    assert not (tmp_path / "b").exists()


def test_refuses_a_bundle_without_this_nodes_board(tmp_path):
    files = {path: content for path, content in BUNDLE_FILES.items() if path != "boards/pico_w.py"}
    manifest = build_manifest(files)
    install = Install(tmp_path, serve_bundle(manifest, files))

    reason = fail_install(install, build_command(manifest))

    assert reason == "the bundle has no boards/pico_w.py for this pico_w board"


@pytest.mark.parametrize("path", ["../main.py", "/main.py", "boards//x.py", "a\\b.py", "./x.py", ""])
def test_refuses_a_manifest_listing_a_path_outside_the_slot(tmp_path, path):
    files = dict(BUNDLE_FILES, **{path: b"x"})
    manifest = build_manifest(files)
    install = Install(tmp_path, serve_bundle(manifest))

    assert "not a safe path" in fail_install(install, build_command(manifest))


@pytest.mark.parametrize("path", ROOT_ONLY_FILES)
def test_refuses_a_bundle_carrying_a_file_only_usb_changes(tmp_path, path):
    files = dict(BUNDLE_FILES, **{path: b"NODE_ID = 'someone-else'\n"})
    manifest = build_manifest(files)
    install = Install(tmp_path, serve_bundle(manifest, files))

    assert fail_install(install, build_command(manifest)) == (
        "the bundle carries %s, which only a USB deploy changes" % path
    )
    assert not (tmp_path / "b").exists()


def test_refuses_a_manifest_for_another_version(tmp_path):
    manifest = build_manifest(version="1.2.9")
    install = Install(tmp_path, serve_bundle(manifest))
    assert "the manifest is for" in fail_install(install, build_command(manifest))


def test_refuses_the_version_already_running(tmp_path):
    install = Install(tmp_path, serve_bundle())
    assert fail_install(install, build_command(version=RUNNING_VERSION)) == "this node already runs 1.2.0"


def test_refuses_on_a_board_not_on_the_slot_layout(tmp_path):
    install = Install(tmp_path, serve_bundle())
    (tmp_path / "slots.json").unlink()
    with pytest.raises(UpdateFailed, match="not on the slot layout"):
        install(build_command())


def test_reports_a_file_it_could_not_fetch(tmp_path):
    files = dict(BUNDLE_FILES)
    del files["deployed_version.py"]
    install = Install(tmp_path, serve_bundle(build_manifest(), files))

    assert "deployed_version.py answered 404" in fail_install(install, build_command())


def test_refuses_when_the_flash_has_too_little_room(tmp_path, monkeypatch):
    install = Install(tmp_path, serve_bundle())
    monkeypatch.setattr("slot_installer.measure_free_flash", lambda path: FREE_FLASH_MARGIN_BYTES)

    assert "bytes of flash are free" in fail_install(install, build_command())


def test_builds_each_file_url_beside_the_manifest_keeping_its_query():
    assert (
        build_file_url(MANIFEST_URL + "?token=t", "boards/pico_w.py")
        == BUNDLE_URL + "/files/boards/pico_w.py?token=t"
    )
