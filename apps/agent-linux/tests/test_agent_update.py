"""The agent's update path: who it answers, how, and when it asks to be restarted."""

from __future__ import annotations

import json

from release_fixtures import (
    NEW_RELEASE,
    RUNNING_RELEASE,
    FakeServer,
    build_update_command,
    make_layout,
)
from tempestas_agent import contract
from tempestas_agent.agent import NOT_INSTALLED_FROM_A_RELEASE
from tempestas_agent.release_installer import ReleaseInstaller, UpdateFailed
from tempestas_agent.release_layout import PendingUpdate, UpdateOutcome
from tempestas_agent.update_gate import GATE_SECONDS
from test_agent import make_agent
from test_update_command import SERVER, build_update

UPDATE_STATUS_TOPIC = contract.build_update_status_topic("bench")
HEARTBEAT = json.dumps({"controller": SERVER, "epoch": 1}).encode()
# The agent judges against the real clock, so its updates must still be fresh then.
FAR_FUTURE = "2099-01-01T00:00:00Z"


def build_fresh_update(**overrides) -> bytes:
    return build_update(**{"expiresAt": FAR_FUTURE, **overrides})


class InlineInstaller:
    """Installs on the calling thread, so a test sees the outcome without waiting."""

    def __init__(self, failure: str | None = None):
        self.failure = failure
        self.commands: list[dict] = []

    def install(self, command, report):
        self.commands.append(command)
        report(contract.UpdateState.DOWNLOADING)
        if self.failure:
            raise UpdateFailed(self.failure)


class InlineThread:
    def __init__(self, target, args, **_options):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


def make_updating_agent(monkeypatch, tmp_path, installer=None):
    monkeypatch.setattr("tempestas_agent.agent.threading.Thread", InlineThread)
    agent, clock = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.installer = installer or InlineInstaller()
    agent.on_heartbeat(HEARTBEAT)
    return agent, clock


def update_statuses(agent) -> list[tuple[str, str | None]]:
    return [
        (payload["state"], payload.get("reason"))
        for topic, payload, _, _ in agent.client.published
        if topic == UPDATE_STATUS_TOPIC
    ]


def test_installs_an_accepted_update_and_asks_to_restart_into_it(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.on_update(build_fresh_update(), retained=False)

    assert update_statuses(agent) == [
        (contract.UpdateState.DOWNLOADING, None),
        (contract.UpdateState.RESTARTING, None),
    ]
    assert agent.restart_requested.is_set()


def test_reports_a_failed_install_and_keeps_running(monkeypatch, tmp_path):
    installer = InlineInstaller(failure="the manifest is not JSON")
    agent, _ = make_updating_agent(monkeypatch, tmp_path, installer)

    agent.on_update(build_fresh_update(), retained=False)
    agent.on_update(build_fresh_update(id="update-2"), retained=False)

    assert update_statuses(agent)[-1] == (contract.UpdateState.FAILED, "the manifest is not JSON")
    assert len(installer.commands) == 2
    assert not agent.restart_requested.is_set()


def test_says_why_it_cannot_update_when_not_installed_from_a_release(monkeypatch):
    agent, _ = make_agent()
    agent.on_heartbeat(HEARTBEAT)

    agent.on_update(build_fresh_update(), retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, NOT_INSTALLED_FROM_A_RELEASE)]


def test_reports_an_update_for_another_app_as_failed(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.on_update(build_fresh_update(app="agent-micropython"), retained=False)

    assert update_statuses(agent)[0][0] == contract.UpdateState.FAILED
    assert agent.installer.commands == []


def test_alarms_on_a_foreign_update_and_never_installs_it(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.on_update(build_fresh_update(issuedBy="laptop"), retained=False)

    alarms = [payload["code"] for payload in agent.client.payloads() if "code" in payload]
    assert alarms == [contract.AlarmCode.CONTROLLER_CONFLICT]
    assert agent.installer.commands == []


def test_refuses_a_second_update_while_one_is_in_progress(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._update_in_progress.acquire()

    agent.on_update(build_fresh_update(), retained=False)

    assert update_statuses(agent) == [
        (contract.UpdateState.FAILED, "another update is in progress")
    ]


def test_a_new_release_reports_healthy_once_it_has_said_hello_and_heard_a_heartbeat(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.release_path(NEW_RELEASE).mkdir()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    agent.layout.switch_current_to(NEW_RELEASE)
    agent.settle_update()

    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)

    assert update_statuses(agent) == [(contract.UpdateState.HEALTHY, None)]
    assert agent.layout.read_pending() is None
    assert agent.update_gate is None


def test_a_new_release_that_hears_no_heartbeat_rolls_back_and_restarts(tmp_path):
    agent, clock = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.release_path(NEW_RELEASE).mkdir()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    agent.layout.switch_current_to(NEW_RELEASE)
    agent.settle_update()
    agent.say_hello()

    clock.advance(GATE_SECONDS)
    agent.check_update_gate()

    assert agent.layout.read_current_release() == RUNNING_RELEASE
    assert agent.restart_requested.is_set()
    assert agent.layout.read_outcome().state == contract.UpdateState.ROLLED_BACK


def test_the_previous_release_reports_the_rollback_once_it_connects(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    reason = f"{NEW_RELEASE} sent no heartbeat within {GATE_SECONDS}s"
    agent.layout.write_outcome(UpdateOutcome("update-1", contract.UpdateState.ROLLED_BACK, reason))
    agent.settle_update()

    agent.report_settled_update()
    agent.report_settled_update()

    assert update_statuses(agent) == [(contract.UpdateState.ROLLED_BACK, reason)]
    assert agent.layout.read_outcome() is None


def test_installs_a_real_bundle_end_to_end(monkeypatch, tmp_path):
    server = FakeServer()
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.installer = ReleaseInstaller(agent.layout, fetch=server.fetch)
    command = build_update_command(server.manifest)
    agent.on_update(
        build_fresh_update(
            manifestUrl=command["manifestUrl"], manifestSha256=command["manifestSha256"]
        ),
        retained=False,
    )

    assert agent.layout.read_current_release() == NEW_RELEASE
    assert [state for state, _ in update_statuses(agent)] == [
        contract.UpdateState.DOWNLOADING,
        contract.UpdateState.VERIFYING,
        contract.UpdateState.INSTALLING,
        contract.UpdateState.RESTARTING,
    ]
