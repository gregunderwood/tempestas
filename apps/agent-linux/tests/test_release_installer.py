"""Installing a bundle: nothing changes on the node until every byte checks out."""

from __future__ import annotations

import json

import pytest

from release_fixtures import (
    BUNDLE_FILES,
    MANIFEST_URL,
    NEW_RELEASE,
    RUNNING_RELEASE,
    FakeServer,
    build_manifest,
    build_update_command,
    make_layout,
)
from tempestas_agent import contract
from tempestas_agent.release_installer import ReleaseInstaller, UpdateFailed, build_file_url
from tempestas_agent.release_layout import PendingUpdate


def install(layout, server: FakeServer, **command_overrides):
    reported: list[str] = []
    command = build_update_command(server.manifest, **command_overrides)
    pending = ReleaseInstaller(layout, fetch=server.fetch).install(command, reported.append)
    return pending, reported


def assert_unchanged(layout):
    assert layout.read_current_release() == RUNNING_RELEASE
    assert layout.read_pending() is None
    assert sorted(entry.name for entry in layout.releases.iterdir()) == [RUNNING_RELEASE]


def test_installs_beside_the_running_release_and_switches_to_it(tmp_path):
    layout = make_layout(tmp_path)

    pending, reported = install(layout, FakeServer())

    assert reported == [
        contract.UpdateState.DOWNLOADING,
        contract.UpdateState.VERIFYING,
        contract.UpdateState.INSTALLING,
    ]
    assert layout.read_current_release() == NEW_RELEASE
    assert pending == PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE)
    assert layout.read_pending() == pending
    for path, data in BUNDLE_FILES.items():
        assert (layout.release_path(NEW_RELEASE) / path).read_bytes() == data
    assert (layout.release_path(RUNNING_RELEASE) / "uv.lock").exists()


def test_refuses_a_manifest_that_is_not_the_one_the_command_pins(tmp_path):
    layout = make_layout(tmp_path)
    server = FakeServer()

    with pytest.raises(UpdateFailed, match="does not match the manifestSha256"):
        install(layout, server, manifestSha256="0" * 64)

    assert_unchanged(layout)


def test_refuses_a_file_that_does_not_match_the_manifest_and_leaves_nothing_behind(tmp_path):
    layout = make_layout(tmp_path)
    server = FakeServer()
    server.files["src/tempestas_agent/deployed_version.py"] = b"tampered\n"

    with pytest.raises(UpdateFailed, match="deployed_version.py does not have the sha256"):
        install(layout, server)

    assert_unchanged(layout)


def test_refuses_a_bundle_whose_dependencies_differ_from_the_nodes(tmp_path):
    layout = make_layout(tmp_path, lock=b"version = 0\n")

    with pytest.raises(UpdateFailed, match="needs tools/deploy-agent-linux.sh"):
        install(layout, FakeServer())

    assert_unchanged(layout)


def test_refuses_a_bundle_with_no_dependency_lock(tmp_path):
    layout = make_layout(tmp_path)
    files = {path: data for path, data in BUNDLE_FILES.items() if path != "uv.lock"}

    with pytest.raises(UpdateFailed, match="has no uv.lock"):
        install(layout, FakeServer(files=files))

    assert_unchanged(layout)


@pytest.mark.parametrize(
    ("manifest_changes", "reason_fragment"),
    [
        ({"app": "agent-micropython"}, 'is for "agent-micropython"'),
        ({"version": "1.1.5"}, 'is for "1.1.5"'),
        ({"files": []}, "lists no files"),
        ({"files": [{"path": "../outside.py", "sha256": "a" * 64}]}, "not a safe path"),
        ({"files": [{"path": "/etc/passwd", "sha256": "a" * 64}]}, "not a safe path"),
        ({"files": [{"path": "main.py", "sha256": "nope"}]}, "not a safe path"),
    ],
    ids=[
        "another app",
        "another version",
        "no files",
        "a parent path",
        "an absolute path",
        "a bad hash",
    ],
)
def test_refuses_a_manifest_that_does_not_describe_this_release(
    tmp_path, manifest_changes, reason_fragment
):
    layout = make_layout(tmp_path)
    manifest = json.loads(build_manifest())
    manifest.update(manifest_changes)

    with pytest.raises(UpdateFailed, match=reason_fragment):
        install(layout, FakeServer(manifest=json.dumps(manifest).encode()))

    assert_unchanged(layout)


def test_refuses_the_version_it_already_runs(tmp_path):
    layout = make_layout(tmp_path, running=NEW_RELEASE)

    with pytest.raises(UpdateFailed, match=f"already runs {NEW_RELEASE}"):
        install(layout, FakeServer())


def test_refuses_when_the_node_does_not_run_from_a_release(tmp_path):
    layout = make_layout(tmp_path)
    layout.current_link.unlink()

    with pytest.raises(UpdateFailed, match="does not run from a release"):
        install(layout, FakeServer())


def test_replaces_a_leftover_partial_download(tmp_path):
    layout = make_layout(tmp_path)
    leftover = layout.unfinished_path(NEW_RELEASE)
    leftover.mkdir()
    (leftover / "stray.py").write_text("left from a crash\n")

    install(layout, FakeServer())

    assert not (layout.release_path(NEW_RELEASE) / "stray.py").exists()
    assert not leftover.exists()


def test_fetches_each_file_beside_the_manifest():
    assert build_file_url(MANIFEST_URL, "src/tempestas_agent/agent.py") == (
        "http://elantris:7000/api/agent-releases/agent-linux/1.1.4/files/src/tempestas_agent/agent.py"
    )
