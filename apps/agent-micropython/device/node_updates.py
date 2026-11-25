"""Updates over the air: judge an update, fill the other slot, then keep or drop the new slot by its gate."""

import contract
from agent_version import AGENT_NAME
from slot_installer import UpdateFailed
from update_gate import HealthGate
from update_guard import ANSWER_ALARM, ANSWER_FAILED_STATUS, judge_update_command

# Long enough for the server to store a hello, short enough for several tries inside the gate.
HELLO_REPEAT_MILLISECONDS = 20000
ANOTHER_UPDATE_IN_PROGRESS = "another update is in progress"
CRITICAL_SEVERITY = "critical"


class NodeUpdates:
    def __init__(self, store, installer, clock, log, reset, running_version):
        self.store = store
        self.installer = installer
        self.clock = clock
        self.log = log
        self.reset = reset
        self.agent = None
        self.gate = self.open_gate_if_running_the_pending_slot(running_version)
        self.is_server_online = False
        self.last_hello_ticks = None

    def report_to(self, agent):
        self.agent = agent

    def open_gate_if_running_the_pending_slot(self, running_version):
        state = self.store.read()
        if state is None or state["pending"] is None:
            return None
        # The bootloader falls back to the active slot when it cannot count a boot.
        if state["pending"]["version"] != running_version:
            return None
        return HealthGate(self.clock, running_version)

    def on_command(self, payload, is_retained, bound_controller, now_seconds):
        verdict = judge_update_command(payload, is_retained, bound_controller, now_seconds, AGENT_NAME)
        if not verdict.is_accepted:
            self.answer_refusal(verdict)
            return
        if self.is_update_in_progress():
            self.agent.send_update_status(
                verdict.command_id, contract.UpdateState.FAILED, ANOTHER_UPDATE_IN_PROGRESS
            )
            return
        self.install(verdict.command)

    def is_update_in_progress(self):
        # Any pending slot counts, as one with a mislabelled version runs with no gate.
        if self.gate is not None:
            return True
        state = self.store.read()
        return state is not None and state["pending"] is not None

    def answer_refusal(self, verdict):
        self.log("refused an update: %s" % verdict.reason)
        if verdict.answer == ANSWER_ALARM:
            self.agent.publish_alarm(verdict.alarm_code, CRITICAL_SEVERITY, verdict.reason)
        elif verdict.answer == ANSWER_FAILED_STATUS:
            self.agent.send_update_status(verdict.command_id, contract.UpdateState.FAILED, verdict.reason)

    def install(self, command):
        command_id = command["id"]

        def report(state):
            self.agent.send_update_status(command_id, state)

        try:
            slot = self.installer.install(command, report)
        except UpdateFailed as error:
            self.log("update %s failed: %s" % (command["version"], error))
            self.agent.send_update_status(command_id, contract.UpdateState.FAILED, str(error))
            return
        self.log("installed %s in slot %s - restarting into it" % (command["version"], slot))
        self.agent.send_update_status(command_id, contract.UpdateState.RESTARTING)
        self.reset()

    def note_hello_sent(self, agent_version):
        self.last_hello_ticks = self.clock.ticks()
        if self.gate is not None:
            self.gate.note_hello(agent_version)

    def note_heartbeat(self, heartbeat):
        """Returns whether to say hello again, as the server has not taken this slot's hello yet."""
        gate = self.gate
        if gate is None:
            return False
        gate.note_heartbeat(heartbeat)
        if gate.is_passed():
            self.keep_new_slot()
            return False
        return gate.is_refused() and self.is_hello_repeat_due()

    def is_hello_repeat_due(self):
        last_hello_ticks = self.last_hello_ticks
        return (
            last_hello_ticks is not None
            and self.clock.elapsed_since(last_hello_ticks) >= HELLO_REPEAT_MILLISECONDS
        )

    def on_server_status(self, is_online):
        self.is_server_online = is_online
        if is_online:
            self.report_outcome()

    def tend(self, is_connected):
        if not is_connected:
            # A reconnect replays the retained server status, so the old one may be stale.
            self.is_server_online = False
        gate = self.gate
        if gate is None:
            return
        gate.count_time(is_connected and self.is_server_online and gate.has_said_hello())
        if gate.is_overdue():
            self.abandon_new_slot(gate.describe_failure())

    def keep_new_slot(self):
        self.log("update gate passed - keeping this slot")
        # Written before the gate is dropped, so a failed write leaves the gate to judge again.
        self.store.keep_pending()
        self.gate = None
        self.report_outcome()

    def abandon_new_slot(self, reason):
        self.log("update gate failed: %s - rolling back" % reason)
        self.store.abandon_pending(reason)
        self.reset()

    def report_outcome(self):
        # Kept until the server is online to read it, so the previous slot can say why it is back.
        if not self.is_server_online:
            return
        state = self.store.read()
        if state is None or state["outcome"] is None:
            return
        outcome = state["outcome"]
        if self.agent.send_update_status(outcome["commandId"], outcome["state"], outcome.get("reason")):
            self.store.clear_outcome()
