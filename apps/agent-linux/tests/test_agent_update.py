"""The agent's update path: who it answers, how, and when it asks to be restarted."""

from __future__ import annotations

import json
import shutil
import time

import pytest

from release_fixtures import (
    NEW_RELEASE,
    RUNNING_RELEASE,
    FakeServer,
    build_update_command,
    make_layout,
)
from tempestas_agent import contract
from tempestas_agent.agent import (
    LAST_OUTCOME_UNDELIVERED,
    LAST_UPDATE_UNSETTLED,
    NOT_INSTALLED_FROM_A_RELEASE,
    STOPPING,
)
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
    agent.settle_update()
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

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [
        (contract.UpdateState.DOWNLOADING, None),
        (contract.UpdateState.RESTARTING, None),
    ]
    assert agent.restart_requested.is_set()


def test_reports_a_failed_install_and_keeps_running(monkeypatch, tmp_path):
    installer = InlineInstaller(failure="the manifest is not JSON")
    agent, _ = make_updating_agent(monkeypatch, tmp_path, installer)

    agent.on_update(build_fresh_update(), is_retained=False)
    agent.on_update(build_fresh_update(id="update-2"), is_retained=False)

    assert update_statuses(agent)[-1] == (contract.UpdateState.FAILED, "the manifest is not JSON")
    assert len(installer.commands) == 2
    assert not agent.restart_requested.is_set()


def test_says_why_it_cannot_update_when_not_installed_from_a_release(monkeypatch):
    agent, _ = make_agent()
    agent.on_heartbeat(HEARTBEAT)

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, NOT_INSTALLED_FROM_A_RELEASE)]


def test_reports_an_update_for_another_app_as_failed(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.on_update(build_fresh_update(app="agent-micropython"), is_retained=False)

    assert update_statuses(agent)[0][0] == contract.UpdateState.FAILED
    assert agent.installer.commands == []


def test_alarms_on_a_foreign_update_and_never_installs_it(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.on_update(build_fresh_update(issuedBy="laptop"), is_retained=False)

    alarms = [payload["code"] for payload in agent.client.payloads() if "code" in payload]
    assert alarms == [contract.AlarmCode.CONTROLLER_CONFLICT]
    assert agent.installer.commands == []


def test_refuses_a_second_update_while_one_is_in_progress(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._update_in_progress.acquire()

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [
        (contract.UpdateState.FAILED, "another update is in progress")
    ]


def test_refuses_an_update_once_the_agent_is_stopping(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.stop_updates()

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, STOPPING)]
    assert agent.installer.commands == []


def test_refuses_an_update_while_a_restart_is_on_its_way(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.restart_requested.set()

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, STOPPING)]


def test_stopping_mid_install_holds_the_switch_lock_so_no_switch_is_cut_off(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-1"

    agent.stop_updates()

    with pytest.raises(BlockingIOError), agent.layout.hold_switch_lock(should_wait=False):
        pass


def test_stopping_with_no_install_leaves_the_switch_lock_to_others(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    agent.stop_updates()

    with agent.layout.hold_switch_lock(should_wait=False):
        pass


def test_a_release_restarts_when_current_was_switched_off_it_before_it_settled(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.loaded_release = agent.layout.locate_release(NEW_RELEASE).resolve()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))

    agent.settle_update()

    assert agent.restart_requested.is_set()
    assert agent.layout.read_pending() is not None
    assert update_statuses(agent) == []


def test_a_release_on_current_settles_without_restarting(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.loaded_release = agent.layout.locate_release(RUNNING_RELEASE).resolve()

    agent.settle_update()

    assert not agent.restart_requested.is_set()


def test_a_stop_reports_the_failure_an_install_recorded_rather_than_the_stop(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-1"
    agent.layout.write_outcome(
        UpdateOutcome("update-1", contract.UpdateState.FAILED, "no space left on device")
    )

    agent.stop_updates()

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, "no space left on device")]


def start_new_release_on_its_gate(tmp_path):
    agent, clock = make_agent()
    agent.layout = make_layout(tmp_path)
    agent.layout.locate_release(NEW_RELEASE).mkdir()
    agent.layout.write_pending(PendingUpdate("update-1", NEW_RELEASE, RUNNING_RELEASE))
    agent.layout.switch_current_to(NEW_RELEASE)
    agent.settle_update()
    agent.is_server_online = True
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
    agent.say_hello()

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert agent.layout.read_current_release() == NEW_RELEASE
    assert not agent.restart_requested.is_set()
    assert update_statuses(agent) == []
    assert agent.update_gate is None


def test_an_update_to_the_version_already_running_is_refused_without_a_restart(
    monkeypatch, tmp_path
):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.installer = ReleaseInstaller(agent.layout)

    agent.on_update(build_fresh_update(version=RUNNING_RELEASE), is_retained=False)

    assert not agent.restart_requested.is_set()
    assert update_statuses(agent)[-1] == (
        contract.UpdateState.FAILED,
        f"this node already runs {RUNNING_RELEASE}",
    )


def test_a_gate_replaced_by_a_hand_deploy_reports_what_the_hand_deploy_recorded(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    replaced = UpdateOutcome(
        agent.update_gate.pending.command_id,
        contract.UpdateState.FAILED,
        "replaced by a hand deploy",
    )
    agent.layout.write_outcome(replaced)
    agent.layout.clear_pending()
    agent.say_hello()

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, "replaced by a hand deploy")]


def test_a_failed_install_that_left_current_switched_restarts_into_it(monkeypatch, tmp_path):
    class SwitchStuckInstaller(InlineInstaller):
        def install(self, command, report):
            self.commands.append(command)
            agent.layout.locate_release(command["version"]).mkdir()
            agent.layout.write_pending(
                PendingUpdate(command["id"], command["version"], RUNNING_RELEASE)
            )
            agent.layout.switch_current_to(command["version"])
            raise OSError("read-only file system")

    agent, _ = make_updating_agent(monkeypatch, tmp_path, SwitchStuckInstaller())

    agent.on_update(build_fresh_update(), is_retained=False)

    assert agent.restart_requested.is_set()
    assert update_statuses(agent) == [(contract.UpdateState.RESTARTING, None)]


def test_a_failed_switch_that_left_its_pending_record_is_left_to_the_next_start(
    monkeypatch, tmp_path
):
    class PendingLeftInstaller(InlineInstaller):
        def install(self, command, report):
            self.commands.append(command)
            agent.layout.write_pending(
                PendingUpdate(command["id"], command["version"], RUNNING_RELEASE)
            )
            raise OSError("input/output error")

    agent, _ = make_updating_agent(monkeypatch, tmp_path, PendingLeftInstaller())

    agent.on_update(build_fresh_update(), is_retained=False)

    assert agent.restart_requested.is_set()
    assert update_statuses(agent) == [(contract.UpdateState.RESTARTING, None)]


def test_a_hello_that_never_left_does_not_count_toward_the_gate(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.client.publish_rc = PUBLISH_NO_CONNECTION

    agent.say_hello()

    assert not agent.update_gate.has_said_hello


def test_a_heartbeat_noted_before_the_deadline_passes_even_if_tended_after_it(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.HEALTHY, None)]
    assert agent.layout.read_current_release() == NEW_RELEASE
    assert not agent.restart_requested.is_set()


def test_prunes_after_a_passed_gate_without_holding_the_switch_lock(tmp_path, monkeypatch):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)
    lock_states_while_pruning = []

    def prune_noting_the_lock(protected, should_wait=True):
        with agent.layout.hold_switch_lock(should_wait=False):
            lock_states_while_pruning.append("free")
        return []

    monkeypatch.setattr(agent.layout, "prune_releases", prune_noting_the_lock)
    agent.tend_update()

    assert lock_states_while_pruning == ["free"]


def test_an_update_thread_that_cannot_start_frees_the_next_update(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)

    class UnstartableThread(InlineThread):
        def start(self):
            raise RuntimeError("can't start new thread")

    monkeypatch.setattr("tempestas_agent.agent.threading.Thread", UnstartableThread)
    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, "can't start new thread")]
    assert agent._update_in_progress.acquire(blocking=False)


def test_ignores_a_repeat_of_the_update_it_is_installing(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-1"
    agent._update_in_progress.acquire()

    agent.on_update(build_fresh_update(id="update-1"), is_retained=False)

    assert update_statuses(agent) == []


def test_ignores_a_repeat_of_the_update_on_its_gate(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.installer = InlineInstaller()

    agent.on_update(build_fresh_update(id=agent.update_gate.pending.command_id), is_retained=False)

    assert update_statuses(agent) == []
    assert agent.installer.commands == []


def test_ignores_a_repeat_of_an_update_whose_outcome_the_server_already_heard(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    command_id = agent.update_gate.pending.command_id
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)
    agent.tend_update()
    agent.tend_update()
    agent.installer = InlineInstaller()

    agent.on_update(build_fresh_update(id=command_id), is_retained=False)

    assert agent.outcome_to_report is None
    assert agent.installer.commands == []
    assert update_statuses(agent) == [(contract.UpdateState.HEALTHY, None)]


def test_an_update_refused_for_a_passing_reason_can_be_retried_under_its_id(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._update_in_progress.acquire()
    agent.on_update(build_fresh_update(), is_retained=False)
    agent._update_in_progress.release()

    agent.on_update(build_fresh_update(), is_retained=False)

    assert len(agent.installer.commands) == 1


def test_a_failure_the_installer_recorded_is_reported_once_and_then_cleared(monkeypatch, tmp_path):
    class RecordingFailureInstaller(InlineInstaller):
        def install(self, command, report):
            self.commands.append(command)
            failure = UpdateOutcome(command["id"], contract.UpdateState.FAILED, "card full")
            agent.layout.write_outcome(failure)
            raise OSError("card full")

    agent, _ = make_updating_agent(monkeypatch, tmp_path, RecordingFailureInstaller())
    agent.is_server_online = True

    agent.on_update(build_fresh_update(), is_retained=False)
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, "card full")]
    assert agent.layout.read_outcome() is None


def test_ignores_a_repeat_of_an_update_that_already_failed(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path, InlineInstaller(failure="no space"))
    agent.on_update(build_fresh_update(), is_retained=False)

    agent.on_update(build_fresh_update(), is_retained=False)

    assert len(agent.installer.commands) == 1
    assert update_statuses(agent)[-1] == (contract.UpdateState.FAILED, "no space")


def test_a_gate_with_nothing_to_roll_back_to_stays_and_reports_at_once(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    shutil.rmtree(agent.layout.locate_release(RUNNING_RELEASE))
    agent.say_hello()

    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert agent.update_gate is None
    assert not agent.restart_requested.is_set()
    assert update_statuses(agent)[-1][0] == contract.UpdateState.FAILED


def test_a_release_the_rollback_unit_switched_away_from_never_records_healthy(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)
    agent.layout.switch_current_to(RUNNING_RELEASE)

    agent.tend_update()

    assert agent.layout.read_outcome() is None
    assert agent.layout.read_pending() is not None
    assert agent.restart_requested.is_set()
    assert update_statuses(agent) == []


def test_an_install_failing_after_a_stop_answered_it_is_not_answered_again(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path, InlineInstaller(failure="timed out"))
    agent._update_in_progress.acquire()
    agent._report_install("update-1", contract.UpdateState.FAILED, STOPPING)

    agent._install_update(json.loads(build_fresh_update()))

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, STOPPING)]


def test_an_outcome_acked_just_before_the_server_left_is_sent_again_when_it_returns(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)
    agent.client.is_delivering = False
    agent.say_hello()
    agent.on_heartbeat(HEARTBEAT)
    agent.tend_update()

    agent._outcome_delivery.has_reached_broker = True
    agent.on_server_status(SERVER_OFFLINE, is_retained=False)
    agent.tend_update()
    agent.on_server_status(SERVER_ONLINE_AGAIN, is_retained=False)

    assert update_statuses(agent).count((contract.UpdateState.HEALTHY, None)) == 2


def test_stopping_waits_only_so_long_for_a_busy_switch_lock(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-7"
    monkeypatch.setattr("tempestas_agent.agent.STOP_SWITCH_WAIT_S", 0.2)

    with agent.layout.hold_switch_lock():
        started_at = time.monotonic()
        agent.stop_updates()

    assert time.monotonic() - started_at < 1
    assert agent.is_stopping
    assert update_statuses(agent) == []


def test_forgetting_a_delivered_outcome_keeps_one_a_failed_install_put_there_meanwhile(
    monkeypatch, tmp_path
):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.is_server_online = True
    delivered = UpdateOutcome("update-1", contract.UpdateState.HEALTHY)
    agent.layout.write_outcome(delivered)
    agent.outcome_to_report = delivered
    agent.report_settled_update()
    newer = UpdateOutcome("update-2", contract.UpdateState.FAILED, "card full")
    read_outcome = agent.layout.read_outcome

    def read_while_an_install_fails():
        agent.outcome_to_report = newer
        return read_outcome()

    monkeypatch.setattr(agent.layout, "read_outcome", read_while_an_install_fails)
    agent.tend_update()

    assert agent.outcome_to_report == newer


def test_stopping_fails_an_install_that_can_no_longer_switch(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-7"

    agent.stop_updates()

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, STOPPING)]


def test_stopping_leaves_an_install_that_already_switched_to_restart(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._installing_command_id = "update-7"
    agent.layout.write_pending(PendingUpdate("update-7", NEW_RELEASE, RUNNING_RELEASE))

    agent.stop_updates()

    assert update_statuses(agent) == []


def test_settling_waits_for_a_switch_another_process_is_making(monkeypatch, tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)

    with agent.layout.hold_switch_lock():
        agent.settle_update()
        assert not agent._is_update_settled

    agent.settle_update()
    assert agent._is_update_settled


SERVER_OFFLINE = json.dumps({"state": "offline"}).encode()
SERVER_ONLINE_AGAIN = json.dumps({"state": "online"}).encode()


def test_a_server_that_goes_offline_pauses_the_gate_instead_of_failing_the_release(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()

    agent.on_server_status(SERVER_OFFLINE, is_retained=False)
    clock.advance(10 * GATE_SECONDS)
    agent.tend_update()

    assert agent.update_gate is not None
    assert not agent.restart_requested.is_set()


def test_a_hello_before_the_server_is_known_online_does_not_start_the_clock(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.is_server_online = False
    agent.say_hello()

    clock.advance(10 * GATE_SECONDS)
    agent.tend_update()
    assert not agent.restart_requested.is_set()

    agent.on_server_status(SERVER_ONLINE_AGAIN, is_retained=True)
    clock.advance(GATE_SECONDS)
    agent.tend_update()
    assert agent.restart_requested.is_set()


def test_a_busy_switch_lock_is_left_for_the_next_tick(tmp_path):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()
    clock.advance(GATE_SECONDS)

    with agent.layout.hold_switch_lock():
        agent.tend_update()
        assert agent.update_gate is not None

    agent.tend_update()
    assert agent.restart_requested.is_set()


def test_restarts_onto_the_previous_release_even_if_the_rollback_cannot_be_recorded(
    tmp_path, monkeypatch
):
    agent, clock = start_new_release_on_its_gate(tmp_path)
    agent.say_hello()

    def fail_writing(_outcome):
        raise OSError("no space left on device")

    monkeypatch.setattr(agent.layout, "write_outcome", fail_writing)
    clock.advance(GATE_SECONDS)
    agent.tend_update()

    assert agent.layout.read_current_release() == RUNNING_RELEASE
    assert agent.restart_requested.is_set()


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
    assert agent.outcome_to_report == agent.layout.read_outcome()


def roll_back_before_this_start(tmp_path):
    agent, _ = make_agent()
    agent.layout = make_layout(tmp_path)
    reason = f"{NEW_RELEASE} heard no heartbeat in {GATE_SECONDS}s with the server online"
    agent.layout.write_outcome(UpdateOutcome("update-1", contract.UpdateState.ROLLED_BACK, reason))
    agent.settle_update()
    agent.is_server_online = True
    return agent, reason


def test_an_outcome_sent_while_the_server_was_away_is_sent_again_when_it_returns(tmp_path):
    agent, reason = roll_back_before_this_start(tmp_path)
    agent.is_server_online = False

    agent.report_settled_update()
    agent.tend_update()
    assert agent.layout.read_outcome() is not None

    agent.on_server_status(SERVER_ONLINE_AGAIN, is_retained=False)
    agent.tend_update()

    assert update_statuses(agent) == [(contract.UpdateState.ROLLED_BACK, reason)] * 2
    assert agent.layout.read_outcome() is None


def test_refuses_an_update_while_the_last_one_could_not_be_settled(monkeypatch, tmp_path):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent._is_update_settled = False

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, LAST_UPDATE_UNSETTLED)]


def test_records_that_the_gated_release_said_hello_for_the_rollback_script(tmp_path):
    agent, _ = start_new_release_on_its_gate(tmp_path)

    agent.say_hello()
    agent.tend_update()

    started = json.loads((agent.layout.state / "started.json").read_text())
    assert started == {"command_id": "update-1"}


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

    agent.on_update(build_fresh_update(), is_retained=False)

    assert update_statuses(agent) == [(contract.UpdateState.FAILED, LAST_OUTCOME_UNDELIVERED)]
    assert agent.installer.commands == []


def test_takes_a_new_update_once_the_last_result_is_delivered_even_before_tidying_up(
    monkeypatch, tmp_path
):
    agent, _ = make_updating_agent(monkeypatch, tmp_path)
    agent.outcome_to_report = UpdateOutcome("update-0", contract.UpdateState.HEALTHY)
    agent.is_server_online = True
    agent.report_settled_update()

    agent.on_update(build_fresh_update(), is_retained=False)

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
        is_retained=False,
    )

    assert agent.layout.read_current_release() == NEW_RELEASE
    assert [state for state, _ in update_statuses(agent)] == [
        contract.UpdateState.DOWNLOADING,
        contract.UpdateState.VERIFYING,
        contract.UpdateState.INSTALLING,
        contract.UpdateState.RESTARTING,
    ]
