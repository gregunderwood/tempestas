"""The rollback unit's script: it switches back only from a pending update that cannot start."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from release_fixtures import NEW_RELEASE, RUNNING_RELEASE, make_layout
from tempestas_agent.release_layout import PendingUpdate
from tempestas_agent.update_gate import settle_update_on_start

ROLLBACK_SCRIPT = Path(__file__).resolve().parents[1] / "systemd/tempestas-agent-rollback.py"


def load_rollback_script():
    spec = importlib.util.spec_from_file_location("tempestas_agent_rollback", ROLLBACK_SCRIPT)
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    return script


@pytest.fixture
def layout(tmp_path, monkeypatch):
    monkeypatch.setenv("TEMPESTAS_AGENT_HOME", str(tmp_path))
    return make_layout(tmp_path)


def install_pending_update(layout) -> None:
    layout.release_path(NEW_RELEASE).mkdir()
    layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    layout.switch_current_to(NEW_RELEASE)


def test_switches_back_from_a_pending_update_and_leaves_it_to_be_reported(layout):
    install_pending_update(layout)

    assert load_rollback_script().main() == 0

    assert layout.read_current_release() == RUNNING_RELEASE
    settlement = settle_update_on_start(layout, now=0.0)
    assert (
        settlement.outcome.reason == f"{NEW_RELEASE} did not start, so {RUNNING_RELEASE} runs again"
    )


def test_does_nothing_when_no_update_is_pending(layout):
    assert load_rollback_script().main() == 1
    assert layout.read_current_release() == RUNNING_RELEASE


def test_does_nothing_twice_so_a_failing_previous_release_is_not_restarted_forever(layout):
    install_pending_update(layout)
    script = load_rollback_script()

    assert script.main() == 0
    assert script.main() == 1
    assert layout.read_current_release() == RUNNING_RELEASE
