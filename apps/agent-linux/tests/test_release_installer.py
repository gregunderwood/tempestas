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
from tempestas_agent.release_installer import (
    FETCH_DEADLINE_S,
    ReleaseInstaller,
    UpdateFailed,
    build_file_url,
    read_within,
)
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
    for path, content in BUNDLE_FILES.items():
        assert (layout.locate_release(NEW_RELEASE) / path).read_bytes() == content
    assert (layout.locate_release(RUNNING_RELEASE) / "uv.lock").exists()


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
    files = {path: content for path, content in BUNDLE_FILES.items() if path != "uv.lock"}

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
    leftover = layout.locate_unfinished_release(NEW_RELEASE)
    leftover.mkdir()
    (leftover / "stray.py").write_text("left from a crash\n")

    install(layout, FakeServer())

    assert not (layout.locate_release(NEW_RELEASE) / "stray.py").exists()
    assert not leftover.exists()


def test_carries_the_manifest_query_to_every_file():
    assert build_file_url("http://elantris/r/1.1.4/manifest.json?token=abc", "src/a.py") == (
        "http://elantris/r/1.1.4/files/src/a.py?token=abc"
    )


def test_fetches_each_file_beside_the_manifest():
    assert build_file_url(MANIFEST_URL, "src/tempestas_agent/agent.py") == (
        "http://elantris:7000/api/agent-releases/agent-linux/1.1.4/files/src/tempestas_agent/agent.py"
    )


def test_a_switch_that_fails_leaves_the_running_release_and_no_pending_update(
    tmp_path, monkeypatch
):
    layout = make_layout(tmp_path)
    switch_current_to = layout.switch_current_to

    def fail_switching_to_the_new_release(release):
        if release == NEW_RELEASE:
            raise OSError("read-only file system")
        switch_current_to(release)

    monkeypatch.setattr(layout, "switch_current_to", fail_switching_to_the_new_release)

    with pytest.raises(OSError):
        install(layout, FakeServer())

    assert_unchanged(layout)


def test_a_switch_back_that_lands_but_cannot_sync_still_drops_the_pending_update(
    tmp_path, monkeypatch
):
    layout = make_layout(tmp_path)
    switch_current_to = layout.switch_current_to

    def switch_then_fail_to_sync(release):
        switch_current_to(release)
        raise OSError("input/output error")

    monkeypatch.setattr(layout, "switch_current_to", switch_then_fail_to_sync)

    with pytest.raises(OSError):
        install(layout, FakeServer())

    assert layout.read_current_release() == RUNNING_RELEASE
    assert layout.read_pending() is None


def test_refuses_to_switch_when_a_hand_deploy_moved_current_during_the_download(tmp_path):
    layout = make_layout(tmp_path)
    server = FakeServer()
    fetch = server.fetch

    def hand_deploy_midway(url):
        if url.endswith("uv.lock"):
            layout.locate_release("1.1.5").mkdir(exist_ok=True)
            layout.switch_current_to("1.1.5")
        return fetch(url)

    server.fetch = hand_deploy_midway

    with pytest.raises(UpdateFailed, match="hand deploy"):
        install(layout, server)

    assert layout.read_current_release() == "1.1.5"
    assert layout.read_pending() is None
    assert not layout.locate_unfinished_release(NEW_RELEASE).exists()


def test_a_pending_record_that_cannot_be_written_leaves_nothing_behind(tmp_path, monkeypatch):
    layout = make_layout(tmp_path)

    def fail_writing(_pending):
        raise OSError("no space left on device")

    monkeypatch.setattr(layout, "write_pending", fail_writing)

    with pytest.raises(OSError, match="no space"):
        install(layout, FakeServer())

    assert_unchanged(layout)


class TricklingResponse:
    def __init__(self, clock):
        self.clock = clock

    def read(self, _size):
        self.clock.append(self.clock[-1] + 30)
        return b"x"


def test_gives_up_on_a_server_that_trickles_bytes_past_the_deadline():
    clock = [0.0]
    response = TricklingResponse(clock)

    with pytest.raises(UpdateFailed, match="took longer"):
        read_within(response, "http://elantris/slow", FETCH_DEADLINE_S, lambda: clock[-1])
