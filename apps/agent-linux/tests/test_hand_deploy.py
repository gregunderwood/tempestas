"""A hand deploy makes the copied release current and drops an unfinished update."""

from __future__ import annotations

from release_fixtures import NEW_RELEASE, RUNNING_RELEASE, make_layout
from tempestas_agent.hand_deploy import main, make_current
from tempestas_agent.release_layout import PendingUpdate


def test_makes_the_copied_release_current_and_drops_a_waiting_update(tmp_path):
    layout = make_layout(tmp_path)
    layout.release_path(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", "1.1.9", RUNNING_RELEASE))

    make_current(layout, NEW_RELEASE)

    assert layout.read_current_release() == NEW_RELEASE
    assert layout.read_pending() is None
    assert layout.release_path(RUNNING_RELEASE).is_dir()


def test_keeps_the_release_a_waiting_update_would_roll_back_to(tmp_path):
    layout = make_layout(tmp_path)
    layout.release_path(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    layout.switch_current_to(NEW_RELEASE)
    for release in ["1.0.1", "1.0.2", "1.0.3"]:
        layout.release_path(release).mkdir()

    make_current(layout, "1.0.3")

    assert layout.release_path(RUNNING_RELEASE).is_dir()
    assert layout.release_path(NEW_RELEASE).is_dir()


def test_refuses_a_release_that_was_never_copied(tmp_path, monkeypatch):
    monkeypatch.setenv("TEMPESTAS_AGENT_HOME", str(tmp_path))
    make_layout(tmp_path)

    assert main(["9.9.9"]) == 1


def test_needs_the_home_and_a_release(monkeypatch):
    monkeypatch.delenv("TEMPESTAS_AGENT_HOME", raising=False)
    assert main([NEW_RELEASE]) == 2
