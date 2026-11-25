"""The agent: announce, sample, obey commands carefully, fail safe. See docs/Safety.md."""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from paho.mqtt.enums import MQTTErrorCode

from . import contract
from . import gpio as gpio_backends
from . import sensor as sensor_backends
from .config import AgentConfig
from .ds18b20 import Ds18b20Sensors, Probe
from .instants import parse_instant
from .release_installer import ReleaseInstaller
from .release_layout import ReleaseLayout, UpdateOutcome
from .update_command import ANSWER_ALARM, ANSWER_FAILED_STATUS, UpdateVerdict, judge_update_command
from .update_gate import (
    HealthGate,
    is_already_settled,
    is_running_another_release,
    is_still_current,
    is_still_pending,
    pass_gate,
    prune_after_update,
    record_start,
    roll_back_gate,
    settle_update_on_start,
)
from .version import AGENT_NAME, read_agent_version
from .world_client import WorldClient

log = logging.getLogger("tempestas.agent")

BOOT_ID_HEX_LENGTH = 12
MILLISECONDS_PER_SECOND = 1000
SEVERITY_CRITICAL = "critical"
SEVERITY_INFO = "info"
SCD4X_METRICS = ("temperature", "humidity", "co2")
SERVER_ONLINE = "online"
SERVER_OFFLINE = "offline"
LAST_OUTCOME_UNDELIVERED = "the last update's result has not reached the server yet"
LAST_UPDATE_UNSETTLED = "the last update is not settled yet, as its state cannot be read"
STOPPING = "the agent is stopping or restarting"
ANOTHER_UPDATE_IN_PROGRESS = "another update is in progress"
PENDING_RECORD_LOST = (
    "its pending record was lost before its health gate finished, so {version} stays"
)
STOP_SWITCH_WAIT_S = 10.0
# Long enough for the server to store a hello, short enough for several tries inside the gate.
HELLO_REPEAT_S = 20.0
RELEASE_ROOT_ABOVE_MODULE = 2
# At import: `current` may be switched later.
LOADED_RELEASE = Path(__file__).resolve().parents[RELEASE_ROOT_ABOVE_MODULE]
SWITCH_LOCK_RETRY_S = 0.1
FINAL_UPDATE_STATES = frozenset(
    {contract.UpdateState.HEALTHY, contract.UpdateState.ROLLED_BACK, contract.UpdateState.FAILED}
)
NOT_INSTALLED_FROM_A_RELEASE = (
    "this agent was not installed from a release, so it cannot update itself; "
    "run tools/deploy-agent-linux.sh"
)


def format_current_time() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class CommandVerdict:
    """Why a command was accepted or refused. Refusals carry an alarm code."""

    is_accepted: bool
    reason: str | None = None
    alarm: str | None = None


def judge_command(
    payload: bytes,
    *,
    is_retained: bool,
    bound_controller: str | None,
    now: datetime,
) -> CommandVerdict:
    """Decide whether a `gpio/set` may be obeyed: cheapest and most dangerous checks first."""
    if is_retained_clear(payload):
        # Reacting to a clear, even by alarming, risks a loop against whoever cleared it.
        return CommandVerdict(False, "empty payload (a retained clear)")

    if is_retained:
        # Catches replay-on-subscribe only; the ownership check below is what protects the relay.
        return CommandVerdict(
            False, "command carried the retain flag", contract.AlarmCode.RETAINED_COMMAND_DROPPED
        )

    try:
        body = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return CommandVerdict(False, "payload is not valid JSON")
    if not isinstance(body, dict):
        return CommandVerdict(False, "payload is not a JSON object")

    if contract.read_schema_major(body.get("schema")) != contract.SUPPORTED_MAJOR:
        return CommandVerdict(False, f"unsupported schema {body.get('schema')!r}")

    issued_by = body.get("issuedBy")
    if bound_controller is not None and issued_by != bound_controller:
        return CommandVerdict(
            False,
            f"issuedBy {issued_by!r} is not the bound controller {bound_controller!r}",
            contract.AlarmCode.CONTROLLER_CONFLICT,
        )

    expiry_refusal = judge_expiry(body.get("expiresAt"), now)
    if expiry_refusal is not None:
        return expiry_refusal

    if not isinstance(body.get("lines"), list) or not body["lines"]:
        return CommandVerdict(False, "command has no lines")
    if not isinstance(body.get("id"), str):
        return CommandVerdict(False, "command has no id")

    return CommandVerdict(True)


def is_retained_clear(payload: bytes) -> bool:
    return payload.strip() == b""


def judge_expiry(expires_at, now: datetime) -> CommandVerdict | None:
    if not isinstance(expires_at, str):
        return CommandVerdict(False, "command has no expiresAt")
    deadline = parse_instant(expires_at)
    if deadline is None:
        return CommandVerdict(False, f"unparseable expiresAt {expires_at!r}")
    if deadline < now:
        return CommandVerdict(False, "command expired", contract.AlarmCode.COMMAND_EXPIRED)
    return None


def has_left_this_node(delivery) -> bool:
    return delivery.rc == MQTTErrorCode.MQTT_ERR_SUCCESS


def is_delivered(delivery) -> bool:
    # paho raises for a publish that never left; reconnecting resends it.
    return has_left_this_node(delivery) and delivery.is_published()


class Agent:
    def __init__(
        self,
        config: AgentConfig,
        client,
        sensor,
        gpio,
        clock=time.monotonic,
        layout: ReleaseLayout | None = None,
        installer: ReleaseInstaller | None = None,
    ):
        self.config = config
        self.client = client
        self.sensor = sensor
        self.gpio = gpio
        self._clock = clock
        self.layout = layout
        self.installer = installer or (ReleaseInstaller(layout) if layout else None)
        self.update_gate = None
        self.outcome_to_report = None
        self._outcome_delivery = None
        self._is_update_settled = False
        self._has_logged_settle_failure = False
        self._was_server_online_at_report = False
        self.is_connected = False
        self.is_server_online = False
        self.restart_requested = threading.Event()
        self.network_thread: threading.Thread | None = None
        self.wake_main_loop = threading.Event()
        self._update_in_progress = threading.Lock()
        self.is_stopping = False
        self._installing_command_id: str | None = None
        self._update_claim_lock = threading.Lock()
        self._settled_command_ids: set[str] = set()
        self._held_until_exit = ExitStack()
        self.boot_id = f"boot-{uuid.uuid4().hex[:BOOT_ID_HEX_LENGTH]}"
        self.agent_version = read_agent_version()
        self.loaded_release = LOADED_RELEASE
        self.sample_sequence = 0
        self.bound_controller: str | None = None
        self.last_heartbeat_at: float | None = None
        self.last_hello_at: float | None = None
        self.is_deadman_tripped = False

    def capabilities(self) -> dict:
        capabilities: dict = {
            "contractVersion": contract.SUPPORTED_MAJOR,
            "contractMinor": contract.MQTT_CONTRACT_MINOR,
            # Only the metrics each sensor has: the dashboard draws a dial per declared metric.
            "sensors": [
                self._describe_sensor(sensor_info) for sensor_info in self.sensor.sensors()
            ],
            "hasRtc": True,
        }
        # Omitted entirely when there are no lines, so the server cannot give this node a device.
        if self.config.has_gpio:
            capabilities["gpio"] = {"pins": list(self.config.gpio.lines), "supportsReadback": True}
        return capabilities

    def hello_payload(self) -> dict:
        return {
            **self._envelope("hello"),
            "kind": self.config.kind,
            "agentName": AGENT_NAME,
            "agentVersion": self.agent_version,
            "bootId": self.boot_id,
            "capabilities": self.capabilities(),
        }

    def status_payload(self, state: str) -> dict:
        return {**self._envelope("status"), "state": state}

    def sample_payload(self, sensor_id: str, reading: sensor_backends.Reading) -> dict:
        # One counter per node: the server's dedupe key includes the sensor, so it is unique enough.
        self.sample_sequence += 1
        return {
            **self._envelope("sample"),
            "seq": self.sample_sequence,
            "sensor": sensor_id,
            "measurements": {
                "co2Ppm": serialize_measurement(reading.co2_ppm),
                "tempC": serialize_measurement(reading.temperature_c),
                "humidityPct": serialize_measurement(reading.humidity_pct),
            },
            "sensorStatus": {
                "ok": True,
                "consecutiveFailures": 0,
                "lastSuccessTs": format_current_time(),
            },
        }

    def gpio_state_payload(self, pin: int) -> dict:
        level = self.gpio.level(pin)
        return {
            **self._envelope("gpioState"),
            "pin": pin,
            "level": level,
            "known": level in gpio_backends.VALID_LEVELS,
        }

    def alarm_payload(self, code: str, severity: str, message: str) -> dict:
        return {
            **self._envelope("alarm"),
            "code": code,
            "severity": severity,
            "message": message,
        }

    def on_command(self, payload: bytes, is_retained: bool) -> dict | None:
        """Judge a `gpio/set` and, if it passes, apply it. Returns the result."""
        verdict = judge_command(
            payload,
            is_retained=is_retained,
            bound_controller=self.bound_controller,
            now=datetime.now(UTC),
        )
        if not verdict.is_accepted:
            self._report_refusal(verdict)
            return None

        body = json.loads(payload)
        line_results = [self._drive_line(line) for line in body["lines"]]
        return {
            **self._envelope("gpioResult"),
            "id": body["id"],
            "ok": all(line_result["ok"] for line_result in line_results),
            "lines": line_results,
        }

    def on_heartbeat(self, payload: bytes) -> None:
        try:
            body = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(body, dict):
            return
        controller = body.get("controller")
        if isinstance(controller, str) and controller != self.bound_controller:
            log.warning("bound to controller %s (epoch %s)", controller, body.get("epoch"))
            self.bound_controller = controller
        self.last_heartbeat_at = self._clock()
        if self.is_deadman_tripped:
            self.is_deadman_tripped = False
            self.publish_alarm(
                contract.AlarmCode.DEADMAN_CLEARED, SEVERITY_INFO, "heartbeats resumed"
            )
        gate = self.update_gate
        if gate is None:
            return
        gate.note_heartbeat(body)
        if self._should_repeat_hello(gate):
            log.info("the server has not taken this release's hello - saying hello again")
            self.say_hello()

    def _should_repeat_hello(self, gate: HealthGate) -> bool:
        if not gate.is_refused():
            return False
        return self.last_hello_at is None or self._clock() - self.last_hello_at >= HELLO_REPEAT_S

    def on_server_status(self, payload: bytes, is_retained: bool) -> None:
        try:
            body = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        state = body.get("state") if isinstance(body, dict) else None
        if state == SERVER_ONLINE:
            self._on_server_online(is_retained)
        elif state == SERVER_OFFLINE:
            self._on_server_offline()

    def _on_server_online(self, is_retained: bool) -> None:
        self.is_server_online = True
        self._start_watching_the_gate()
        # A retained online is the broker's replay, already answered by announce.
        if not is_retained:
            log.info("the server came back online - saying hello again")
            self.say_hello()
        if self._was_outcome_sent_while_server_away():
            self.report_settled_update()

    def _on_server_offline(self) -> None:
        self.is_server_online = False
        # A broker ack does not prove the server read it.
        self._was_server_online_at_report = False
        self._stop_watching_the_gate()
        log.warning(
            "the server reported itself offline - holding the lines for the dead-man (%.0fs)",
            self.config.deadman_s,
        )

    def say_hello(self) -> None:
        topic = contract.build_hello_topic(self.config.node_id)
        delivery = self.publish("hello", topic, self.hello_payload())
        if has_left_this_node(delivery):
            self.last_hello_at = self._clock()
        # Read once: the main loop may drop the gate meanwhile.
        gate = self.update_gate
        if gate is not None and has_left_this_node(delivery):
            gate.note_hello(self.agent_version)
            if self.is_server_online:
                gate.start_watching(self._clock())

    def on_connected(self) -> None:
        self.is_connected = True

    def on_disconnected(self) -> None:
        self.is_connected = False
        self.is_server_online = False
        self._stop_watching_the_gate()

    def settle_update(self) -> None:
        try:
            settlement = settle_update_on_start(self.layout, self.loaded_release)
        except BlockingIOError:
            return
        except OSError as error:
            # A bad card must not stop the dead-man starting.
            if not self._has_logged_settle_failure:
                log.error("could not settle the last update; trying again each tick: %s", error)
                self._has_logged_settle_failure = True
            return
        if self._has_logged_settle_failure:
            log.info("settled the last update after all")
        if settlement.should_restart:
            log.warning(
                "`current` moved off %s after this process loaded it - restarting into it",
                self.loaded_release.name,
            )
            self.request_restart()
            return
        self.update_gate = settlement.gate
        self.outcome_to_report = settlement.outcome
        # Last: on_update trusts the gate and outcome once this is set.
        self._is_update_settled = True
        if self.is_connected:
            # Announced before the gate existed, so say hello again for it.
            self.say_hello()
            self.report_settled_update()

    def report_settled_update(self) -> None:
        outcome = self.outcome_to_report
        if outcome is None:
            return
        self._was_server_online_at_report = self.is_server_online
        self._settled_command_ids.add(outcome.command_id)
        self._outcome_delivery = self.publish_update_status(
            outcome.command_id, outcome.state, outcome.reason
        )

    def on_update(self, payload: bytes, is_retained: bool) -> None:
        verdict = judge_update_command(
            payload,
            is_retained=is_retained,
            bound_controller=self.bound_controller,
            running_app=AGENT_NAME,
            now=datetime.now(UTC),
        )
        if self._is_known_update(verdict.command_id):
            # Answering a redelivery would contradict what it reported.
            log.info("ignored a repeat of update %s", verdict.command_id)
            return
        if not verdict.is_accepted:
            self._report_update_refusal(verdict)
            return
        # Shared with stop_updates, so nothing is claimed once stopping.
        with self._update_claim_lock:
            refusal = self._claim_update_or_explain_refusal(verdict.command_id)
        if refusal is not None:
            self._report_install(verdict.command_id, contract.UpdateState.FAILED, refusal)
            return
        try:
            # Off the MQTT thread, so a download never delays commands.
            threading.Thread(
                target=self._install_update, args=(verdict.command,), name="update", daemon=True
            ).start()
        except RuntimeError as error:
            with self._update_claim_lock:
                self._installing_command_id = None
                self._update_in_progress.release()
            self._report_install(verdict.command_id, contract.UpdateState.FAILED, str(error))

    def remove_unfinished_downloads(self) -> None:
        if self.layout is None:
            return
        try:
            removed = self.layout.remove_unfinished_downloads()
        except OSError as error:
            log.error("could not remove unfinished downloads: %s", error)
            return
        for name in removed:
            log.info("removed the unfinished download %s", name)

    def stop_updates(self) -> None:
        """So the process never exits halfway through a switch."""
        with self._update_claim_lock:
            self.is_stopping = True
            installing_command_id = self._installing_command_id
        if self.layout is None or installing_command_id is None:
            # Nothing can switch, so the relays need not wait.
            return
        try:
            if self._hold_switch_lock_until_exit():
                self._fail_an_install_that_cannot_switch(installing_command_id)
        except OSError as error:
            log.error("could not hold the switch lock while stopping: %s", error)

    def _hold_switch_lock_until_exit(self) -> bool:
        deadline = time.monotonic() + STOP_SWITCH_WAIT_S
        while True:
            try:
                self._held_until_exit.enter_context(self.layout.hold_switch_lock(should_wait=False))
                return True
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    log.error("stopping without the switch lock: it stayed busy")
                    return False
                time.sleep(SWITCH_LOCK_RETRY_S)

    def _fail_an_install_that_cannot_switch(self, command_id: str) -> None:
        pending = self.layout.read_pending()
        if pending is not None and pending.command_id == command_id:
            return
        self._report_failed_install(command_id, STOPPING)

    def has_current_moved_off_this_release(self) -> bool:
        if self.layout is None:
            return False
        try:
            return is_running_another_release(self.layout, self.loaded_release)
        except OSError:
            return False

    def request_restart(self) -> None:
        self.restart_requested.set()
        self.wake_main_loop.set()

    def tend_update(self) -> None:
        if not self._is_update_settled:
            self.settle_update()
        self._record_start_of_gated_release()
        self._settle_update_gate()
        self._forget_delivered_outcome()

    def publish_update_status(self, command_id: str, state: str, reason: str | None = None):
        payload = {**self._envelope("updateStatus"), "id": command_id, "state": state}
        if reason is not None:
            payload["reason"] = reason
        return self.publish(
            "updateStatus", contract.build_update_status_topic(self.config.node_id), payload
        )

    def enter_failsafe(self, code: str, message: str) -> None:
        # Hardware, then the retained state, then the alarm: whoever reacts already has the truth.
        self.gpio.failsafe()
        self.publish_gpio_state(self.config.gpio.lines)
        self.publish_alarm(code, SEVERITY_CRITICAL, message)

    def check_deadman(self) -> bool:
        """Fail safe locally when the controller goes quiet. Returns True if it trips."""
        if self.last_heartbeat_at is None or self.is_deadman_tripped:
            return False
        if not self._is_heartbeat_overdue():
            return False

        self.is_deadman_tripped = True
        log.error("no heartbeat for %.0fs - entering failsafe", self.config.deadman_s)
        self.enter_failsafe(
            contract.AlarmCode.DEADMAN_TRIPPED,
            f"no controller heartbeat for {self.config.deadman_s:.0f}s",
        )
        return True

    def publish(self, message_kind: str, topic: str, payload: dict):
        qos, retain = contract.QOS[message_kind]
        return self.client.publish(topic, json.dumps(payload), qos=qos, retain=retain)

    def publish_gpio_state(self, pins) -> None:
        for pin in pins:
            self.publish(
                "gpioState",
                contract.build_gpio_state_topic(self.config.node_id, pin),
                self.gpio_state_payload(pin),
            )

    def publish_alarm(self, code: str, severity: str, message: str) -> None:
        self.publish(
            "alarm",
            contract.build_alarm_topic(self.config.node_id),
            self.alarm_payload(code, severity, message),
        )

    def _envelope(self, schema_kind: str) -> dict:
        return {
            "schema": contract.SCHEMAS[schema_kind],
            "node": self.config.node_id,
            "ts": format_current_time(),
        }

    def _describe_sensor(self, sensor_info: sensor_backends.SensorInfo) -> dict:
        return {
            "sensorId": sensor_info.sensor_id,
            "kind": sensor_info.kind,
            "metrics": list(sensor_info.metrics),
            "sampleIntervalMs": int(self.config.sensor.sample_interval_s * MILLISECONDS_PER_SECOND),
        }

    def _report_refusal(self, verdict: CommandVerdict) -> None:
        if verdict.alarm:
            log.error("refused a command: %s", verdict.reason)
            self.publish_alarm(verdict.alarm, SEVERITY_CRITICAL, verdict.reason or "refused")
        else:
            log.debug("ignored a command: %s", verdict.reason)

    def _settle_update_gate(self) -> None:
        gate = self.update_gate
        if gate is None:
            return
        has_passed = gate.is_passed()
        if not has_passed and not gate.is_overdue(self._clock()):
            return
        try:
            with self.layout.hold_switch_lock(should_wait=False):
                should_prune = self._settle_gate_while_locked(gate, has_passed)
        except BlockingIOError:
            return
        except OSError as error:
            log.error("could not settle the update to %s: %s", gate.pending.version, error)
            return
        self.update_gate = None
        if should_prune:
            self._prune_after_passing(gate)

    def _settle_gate_while_locked(self, gate: HealthGate, has_passed: bool) -> bool:
        if not is_still_pending(self.layout, gate):
            self._report_update_replaced_by_hand_deploy(gate)
            return False
        if not is_still_current(self.layout, gate):
            log.warning("update to %s was rolled back under it", gate.pending.version)
            self.request_restart()
            return False
        if not has_passed:
            self._fail_update_gate(gate)
            return False
        self._pass_update_gate(gate)
        return True

    def _report_update_replaced_by_hand_deploy(self, gate: HealthGate) -> None:
        log.warning("update to %s was replaced by a hand deploy", gate.pending.version)
        recorded = self.layout.read_outcome()
        if is_already_settled(recorded, gate.pending):
            self.outcome_to_report = recorded
            self.report_settled_update()
            return
        self._report_install(
            gate.pending.command_id,
            contract.UpdateState.FAILED,
            PENDING_RECORD_LOST.format(version=gate.pending.version),
        )

    def _pass_update_gate(self, gate: HealthGate) -> None:
        log.info("update to %s passed its health gate", gate.pending.version)
        self.outcome_to_report = pass_gate(self.layout, gate)
        self.report_settled_update()

    def _prune_after_passing(self, gate: HealthGate) -> None:
        # Outside the lock, so a slow prune never blocks a deploy.
        try:
            prune_after_update(self.layout, gate.pending)
        except BlockingIOError:
            log.info("did not prune old releases: the switch lock is busy")
        except OSError as error:
            log.error("could not prune old releases: %s", error)

    def _fail_update_gate(self, gate: HealthGate) -> None:
        # Described once, so a heartbeat arriving meanwhile cannot split the log from the record.
        reason = gate.describe_failure()
        log.error("update gate failed: %s - rolling back", reason)
        try:
            # Unsent: the previous release reports it after the restart.
            self.outcome_to_report = roll_back_gate(self.layout, gate, reason)
        finally:
            if self._has_switched_back(gate):
                self.request_restart()
        if not self.restart_requested.is_set():
            # No restart means nothing to roll back to, so report now.
            self.report_settled_update()

    def _has_switched_back(self, gate: HealthGate) -> bool:
        return self.layout.read_current_release() == gate.pending.previous_release

    def _was_outcome_sent_while_server_away(self) -> bool:
        return not self._was_server_online_at_report

    def _start_watching_the_gate(self) -> None:
        gate = self.update_gate
        if gate is not None and gate.has_said_hello:
            gate.start_watching(self._clock())

    def _stop_watching_the_gate(self) -> None:
        gate = self.update_gate
        if gate is not None:
            gate.stop_watching(self._clock())

    def _claim_update_or_explain_refusal(self, command_id: str) -> str | None:
        if self.installer is None:
            return NOT_INSTALLED_FROM_A_RELEASE
        if self.is_stopping or self.restart_requested.is_set():
            return STOPPING
        if not self._is_update_settled:
            return LAST_UPDATE_UNSETTLED
        if self._has_undelivered_outcome():
            # Installing would clear an outcome the server has not heard.
            return LAST_OUTCOME_UNDELIVERED
        if self.update_gate is not None:
            return ANOTHER_UPDATE_IN_PROGRESS
        if not self._update_in_progress.acquire(blocking=False):
            return ANOTHER_UPDATE_IN_PROGRESS
        self._installing_command_id = command_id
        return None

    def _is_known_update(self, command_id: str | None) -> bool:
        if command_id is None:
            return False
        gate, outcome = self.update_gate, self.outcome_to_report
        known_ids = {
            self._installing_command_id,
            gate.pending.command_id if gate is not None else None,
            outcome.command_id if outcome is not None else None,
        }
        return command_id in known_ids or command_id in self._settled_command_ids

    def _has_undelivered_outcome(self) -> bool:
        delivery = self._outcome_delivery
        has_server_heard_it = (
            delivery is not None and is_delivered(delivery) and self._was_server_online_at_report
        )
        return self.outcome_to_report is not None and not has_server_heard_it

    def _record_start_of_gated_release(self) -> None:
        gate = self.update_gate
        if gate is None or gate.is_start_recorded or not gate.has_said_hello:
            return
        try:
            with self.layout.hold_switch_lock(should_wait=False):
                if is_still_pending(self.layout, gate):
                    record_start(self.layout, gate)
        except BlockingIOError:
            return
        except OSError as error:
            log.error("could not record that %s started: %s", gate.pending.version, error)
            return
        gate.is_start_recorded = True

    def _forget_delivered_outcome(self) -> None:
        outcome = self.outcome_to_report
        if outcome is None or self._has_undelivered_outcome():
            return
        try:
            with self.layout.hold_switch_lock(should_wait=False):
                # A hand deploy may have recorded a newer one.
                if self.layout.read_outcome() == outcome:
                    self.layout.clear_outcome()
        except BlockingIOError:
            return
        except OSError as error:
            log.error("could not forget a delivered update outcome: %s", error)
            return
        with self._update_claim_lock:
            # A failed install may have set a newer one.
            if self.outcome_to_report is outcome:
                self.outcome_to_report = None
                self._outcome_delivery = None

    def _install_update(self, command: dict) -> None:
        command_id = command["id"]
        try:
            self.installer.install(
                command, report=lambda state: self._report_install(command_id, state)
            )
        except Exception as error:  # noqa: BLE001 - reported to the server, never swallowed
            log.error("update to %s failed: %s", command.get("version"), error)
            if self._is_left_for_the_next_start(command_id):
                log.error(
                    "could not undo the switch to %s - restarting to settle it", command["version"]
                )
                self._report_restart_into(command_id)
                return
            try:
                self._report_failed_install(command_id, str(error))
            finally:
                self._installing_command_id = None
                self._update_in_progress.release()
            return
        log.warning("installed %s - restarting into it", command["version"])
        self._report_restart_into(command_id)

    def _report_restart_into(self, command_id: str) -> None:
        try:
            # Before the restart stops the network loop, or it is often lost.
            self.publish_update_status(command_id, contract.UpdateState.RESTARTING)
        finally:
            # `current` has switched, so restart even if the publish failed.
            self.request_restart()

    def _is_left_for_the_next_start(self, command_id: str) -> bool:
        try:
            pending = self.layout.read_pending()
        except OSError:
            return False
        return pending is not None and pending.command_id == command_id

    def _report_failed_install(self, command_id: str, reason: str) -> None:
        recorded = self._read_recorded_outcome(command_id)
        if recorded is None:
            self._report_install(command_id, contract.UpdateState.FAILED, reason)
            return
        with self._update_claim_lock:
            if command_id in self._settled_command_ids:
                return
            self.outcome_to_report = recorded
            self.report_settled_update()

    def _read_recorded_outcome(self, command_id: str) -> UpdateOutcome | None:
        try:
            recorded = self.layout.read_outcome()
        except OSError:
            return None
        return recorded if recorded is not None and recorded.command_id == command_id else None

    def _report_install(self, command_id: str, state: str, reason: str | None = None) -> None:
        # A stop and the install thread may both answer; only one may.
        with self._update_claim_lock:
            if command_id in self._settled_command_ids:
                return
            if state in FINAL_UPDATE_STATES:
                self._settled_command_ids.add(command_id)
            self.publish_update_status(command_id, state, reason)

    def _report_update_refusal(self, verdict: UpdateVerdict) -> None:
        if verdict.answer == ANSWER_ALARM:
            log.error("refused an update: %s", verdict.reason)
            self.publish_alarm(verdict.alarm, SEVERITY_CRITICAL, verdict.reason)
        elif verdict.answer == ANSWER_FAILED_STATUS:
            log.error("refused an update: %s", verdict.reason)
            self._report_install(verdict.command_id, contract.UpdateState.FAILED, verdict.reason)
        else:
            log.info("ignored an update: %s", verdict.reason)

    def _drive_line(self, line: dict) -> dict:
        pin, level = int(line["pin"]), int(line["level"])
        try:
            self.gpio.write(pin, level)
            readback = self.gpio.level(pin)
        except Exception as error:  # noqa: BLE001 - reported, never swallowed
            log.error("pin %s could not be driven: %s", pin, error)
            return {
                "pin": pin,
                "requested": level,
                "readback": None,
                "ok": False,
                "error": str(error),
            }
        # An unreadable readback is a failure too: unknown on a burner relay is not done.
        return {"pin": pin, "requested": level, "readback": readback, "ok": readback == level}

    def _is_heartbeat_overdue(self) -> bool:
        return self._clock() - self.last_heartbeat_at >= self.config.deadman_s


def serialize_measurement(measurement: sensor_backends.Measurement) -> dict:
    serialized: dict = {
        "value": measurement.value,
        "valid": measurement.valid,
        "unit": measurement.unit,
    }
    if measurement.reason:
        serialized["reason"] = measurement.reason
    return serialized


def build_backends(config: AgentConfig, simulated: bool):
    """Wire the sensor and GPIO backends the configuration asks for."""
    world_client = WorldClient(config.world.url) if config.world.url else None
    gpio = _build_gpio(config, world_client, simulated)
    gpio.claim(config.gpio.lines, config.gpio.failsafe)
    return _build_sensor_set(config, world_client, gpio, simulated), gpio


def _build_gpio(config: AgentConfig, world_client: WorldClient | None, simulated: bool):
    if world_client is not None and config.gpio.lines:
        return gpio_backends.WorldGpio(config.node_id, world_client)
    return gpio_backends.build(config.gpio.lines, config.gpio.chip_label, simulated)


def _build_sensor_set(config: AgentConfig, world_client: WorldClient | None, gpio, simulated: bool):
    sensor_config = config.sensor
    if sensor_config.kind == "ds18b20" and not simulated:
        return Ds18b20Sensors(
            tuple(Probe(probe.rom, probe.sensor_id) for probe in sensor_config.probes),
            w1_root=sensor_config.w1_root,
            max_change_c_per_min=sensor_config.temperature_max_change_c_per_min,
        )
    sensor_info = sensor_backends.SensorInfo(sensor_config.sensor_id, "scd4x", SCD4X_METRICS)
    return sensor_backends.SingleSensor(
        _build_single_sensor(config, world_client, gpio, simulated), sensor_info
    )


def _build_single_sensor(
    config: AgentConfig, world_client: WorldClient | None, gpio, simulated: bool
):
    sensor_config = config.sensor
    if world_client is not None and sensor_config.kind == "world":
        return sensor_backends.WorldSensor(
            world_client, config.world.position, offset_c=sensor_config.temperature_offset_c
        )
    if sensor_config.kind == "simulated" or simulated:
        return sensor_backends.SimulatedSensor(gpio=gpio if config.has_gpio else None)
    return sensor_backends.Scd4xSensor(
        bus=sensor_config.bus,
        address=sensor_config.address,
        offset_c=sensor_config.temperature_offset_c,
        altitude_m=sensor_config.altitude_m,
        co2_min_ppm=sensor_config.co2_min_ppm,
        co2_max_ppm=sensor_config.co2_max_ppm,
        asc_enabled=sensor_config.automatic_self_calibration,
        max_change_ppm_per_min=sensor_config.co2_max_change_ppm_per_min,
    )
