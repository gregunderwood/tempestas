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
from tempestas_agent.agent import LAST_OUTCOME_UNDELIVERED, NOT_INSTALLED_FROM_A_RELEASE
from tempestas_agent.release_installer import ReleaseInstaller, UpdateFailed
from tempestas_agent.release_layout import PendingUpdate, UpdateOutcome
from tempestas_agent.update_gate import GATE_SECONDS
from test_agent import PUBLISH_NO_CONNECTION, make_agent
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


def start_new_release_on_its_gate(tmp_path):
    agent, clock = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.locate_release(NEW_RELEASE).mkdir()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    agent.layout.switch_current_to(NEW_RELEASE)
    agent.settle_update()
    return agent, clock


def test_a_new_release_reports_healthy_once_it_has_said_hello_and_heard_a_heartbeat(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)

    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)
    assert update_statuses(agent) == []
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.HEALTHY, None)]
    assert agent.layout.read_pending() is None
    assert agent.update_gate is None


def test_a_healthy_update_is_kept_until_the_broker_has_it(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.client.is_delivering = False
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)

    agent.tend_update()

    assert agent.layout.read_outcome().state == contract.UpdateState.HEALTHY


def test_a_gate_replaced_by_a_hand_deploy_neither_passes_nor_rolls_back(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.layout.clear_pending()

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert agent.layout.read_current_release() == NEW_RELEASE
    assert not agent.restart_requested.is_set()
    assert update_statuses(agent) == []


def test_a_heartbeat_noted_before_the_deadline_passes_even_if_tended_after_it(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.HEALTHY, None)]
    assert agent.layout.read_current_release() == NEW_RELEASE
    assert not agent.restart_requested.is_set()


SERVER_OFFLINE = json.dumps({"state": "offline"}).encode()


def test_a_server_that_goes_offline_pauses_the_gate_instead_of_failing_the_release(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()

    agent.on_server_status(SERVER_OFFLINE, retained=False)
    clock.advance(10 * GATE_SECONDS)
    agent.tend_update()

    assert agent.update_gate is not None
    assert not agent.restart_requested.is_set()


def test_a_lost_broker_connection_pauses_the_gate(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()

    agent.on_disconnected()
    clock.advance(10 * GATE_SECONDS)
    agent.tend_update()

    assert not agent.restart_requested.is_set()


def test_a_settlement_that_failed_at_start_is_tried_again_and_announced(tmp_path, monkeypatch):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.locate_release(NEW_RELEASE).mkdir()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    agent.layout.switch_current_to(NEW_RELEASE)
    read_pending = agent.layout.read_pending

    def fail_reading():
        raise OSError("input/output error")

    monkeypatch.setattr(agent.layout, "read_pending", fail_reading)
    agent.settle_update()
    agent.on_connected()
    monkeypatch.setattr(agent.layout, "read_pending", read_pending)

    agent.tend_update()

    assert agent.update_gate is not None
    assert agent.update_gate.has_said_hello
    assert contract.build_hello_topic("bench") in agent.client.topics()


def test_a_new_release_that_hears_no_heartbeat_rolls_back_and_restarts(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert agent.layout.read_current_release() == RUNNING_RELEASE
    assert agent.restart_requested.is_set()
    assert agent.layout.read_outcome().state == contract.UpdateState.ROLLED_BACK
    assert update_statuses(agent) == []


def roll_back_before_this_start(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    reason = f"{NEW_RELEASE} heard no heartbeat in {GATE_SECONDS}s with the server online"
    agent.layout.write_outcome(UpdateOutcome("update-1", contract.UpdateState.ROLLED_BACK, reason))
    agent.settle_update()
    return agent, reason


def test_the_previous_release_reports_the_rollback_once_it_connects(tmp_path):
    agent, reason = roll_back_before_this_start(tmp_path)

    agent.report_settled_update()
    agent.tend_update()
    agent.report_settled_update()

    assert update_statuses(agent) == [(contract.UpdateState.ROLLED_BACK, reason)]
    assert agent.layout.read_outcome() is None


def test_keeps_the_rollback_until_the_broker_has_it_and_sends_it_again_on_reconnect(tmp_path):
    agent, reason = roll_back_before_this_start(tmp_path)
    agent.client.is_delivering = False

    agent.report_settled_update()
    agent.tend_update()
    assert agent.layout.read_outcome() is not None

    agent.client.is_delivering = True
    agent.report_settled_update()
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.ROLLED_BACK, reason)] * 2
    assert agent.layout.read_outcome() is None


def test_refuses_a_new_update_until_the_last_result_has_reached_the_server(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.outcome_to_report = UpdateOutcome("update-0", contract.UpdateState.HEALTHY)

    agent.on_update(build_fresh_update(), retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, LAST_OUTCOME_UNDELIVERED)]
    assert agent.installer.commands == []


def test_takes_a_new_update_once_the_last_result_is_delivered_even_before_tidying_up(
    monkeypatch, tmp_path
):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.outcome_to_report = UpdateOutcome("update-0", contract.UpdateState.HEALTHY)
    agent.report_settled_update()

    agent.on_update(build_fresh_update(), retained=False)

    assert len(agent.installer.commands) == 1


def test_a_gate_that_cannot_be_settled_is_kept_and_tried_again_on_the_next_tick(
    tmp_path, monkeypatch
):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    switch_current_to = agent.layout.switch_current_to

    def fail_switching(_release):
        raise OSError("read-only file system")

    monkeypatch.setattr(agent.layout, "switch_current_to", fail_switching)
    clock.advance(GATE_SECONDS)
    agent.tend_update()
    assert agent.update_gate is not None
    assert not agent.restart_requested.is_set()

    monkeypatch.setattr(agent.layout, "switch_current_to", switch_current_to)
    agent.tend_update()

    assert agent.layout.read_current_release() == RUNNING_RELEASE
    assert agent.restart_requested.is_set()


def test_starts_without_a_gate_when_the_update_state_cannot_be_written(tmp_path, monkeypatch):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))

    def fail_writing(_outcome):
        raise OSError("no space left on device")

    monkeypatch.setattr(agent.layout, "write_outcome", fail_writing)
    agent.settle_update()

    assert agent.update_gate is None
    assert agent.outcome_to_report is None


def test_keeps_an_outcome_a_hand_deploy_recorded_after_the_last_one_was_sent(tmp_path):
    agent, _ = roll_back_before_this_start(tmp_path)
    agent.report_settled_update()
    newer = UpdateOutcome("update-2", contract.UpdateState.FAILED, "replaced by a hand deploy")
    agent.layout.write_outcome(newer)

    agent.tend_update()

    assert agent.layout.read_outcome() == newer


def test_a_publish_made_while_disconnected_is_kept_for_the_next_connect(tmp_path):
    agent, _ = roll_back_before_this_start(tmp_path)
    agent.client.publish_rc = PUBLISH_NO_CONNECTION

    agent.report_settled_update()
    agent.tend_update()

    assert agent.outcome_to_report is not None
    assert agent.layout.read_outcome() is not None


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
