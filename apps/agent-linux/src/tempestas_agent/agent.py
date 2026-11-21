"""The agent: announce, sample, obey commands carefully, fail safe. See docs/Safety.md."""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from . import contract
from . import gpio as gpio_backends
from . import sensor as sensor_backends
from .config import AgentConfig
from .ds18b20 import Ds18b20Sensors, Probe
from .version import read_agent_version
from .world_client import WorldClient

log = logging.getLogger("tempestas.agent")

BOOT_ID_HEX_LENGTH = 12
MILLISECONDS_PER_SECOND = 1000
SEVERITY_CRITICAL = "critical"
SEVERITY_INFO = "info"
SCD4X_METRICS = ("temperature", "humidity", "co2")


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
    retained: bool,
    bound_controller: str | None,
    now: datetime,
) -> CommandVerdict:
    """Decide whether a `gpio/set` may be obeyed: cheapest and most dangerous checks first."""
    if is_retained_clear(payload):
        # Reacting to a clear, even by alarming, risks a loop against whoever cleared it.
        return CommandVerdict(False, "empty payload (a retained clear)")

    if retained:
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
    try:
        deadline = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return CommandVerdict(False, f"unparseable expiresAt {expires_at!r}")
    if deadline < now:
        return CommandVerdict(False, "command expired", contract.AlarmCode.COMMAND_EXPIRED)
    return None


class Agent:
    def __init__(self, config: AgentConfig, client, sensor, gpio, clock=time.monotonic):
        self.config = config
        self.client = client
        self.sensor = sensor
        self.gpio = gpio
        self._clock = clock
        self.boot_id = f"boot-{uuid.uuid4().hex[:BOOT_ID_HEX_LENGTH]}"
        self.agent_version = read_agent_version()
        self.sample_sequence = 0
        self.bound_controller: str | None = None
        self.last_heartbeat_at: float | None = None
        self.is_deadman_tripped = False

    def capabilities(self) -> dict:
        capabilities: dict = {
            "contractVersion": contract.SUPPORTED_MAJOR,
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

    def on_command(self, payload: bytes, retained: bool) -> dict | None:
        """Judge a `gpio/set` and, if it passes, apply it. Returns the result."""
        verdict = judge_command(
            payload,
            retained=retained,
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

    def publish(self, message_kind: str, topic: str, payload: dict) -> None:
        qos, retain = contract.QOS[message_kind]
        self.client.publish(topic, json.dumps(payload), qos=qos, retain=retain)

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
