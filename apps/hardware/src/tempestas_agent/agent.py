"""The agent: connect, announce, sample, obey (carefully), fail safe.

The command path is where the care goes. Every guard here exists because of a
specific way this can hurt something - see the module docstring in contract.py
and docs/Safety.md.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from . import contract
from . import gpio as gpio_mod
from . import sensor as sensor_mod
from .config import AgentConfig

log = logging.getLogger("tempestas.agent")


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass
class CommandVerdict:
    """Why a command was accepted or refused. Refusals carry an alarm code."""

    accept: bool
    reason: str | None = None
    alarm: str | None = None


def judge_command(
    payload: bytes,
    *,
    retained: bool,
    bound_controller: str | None,
    now: datetime,
) -> CommandVerdict:
    """Decide whether a `gpio/set` may be obeyed. Pure, so it can be asserted.

    The order matters: the cheapest and most dangerous checks come first.
    """
    # An empty payload is how a RETAINED command is cleared. Reacting to it -
    # even to log loudly - risks a loop against whoever cleared it.
    if payload.strip() == b"":
        return CommandVerdict(False, "empty payload (a retained clear)")

    # A retained command replays on every reconnect. This catches the
    # replay-on-subscribe case; it does NOT catch a retained command published
    # while we are already connected, which is why the ownership check below is
    # the one that actually protects the relay.
    if retained:
        return CommandVerdict(
            False, "command carried the retain flag", contract.AlarmCode.RETAINED_COMMAND_DROPPED
        )

    try:
        body = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return CommandVerdict(False, "payload is not valid JSON")
    if not isinstance(body, dict):
        return CommandVerdict(False, "payload is not a JSON object")

    major = contract.schema_major(body.get("schema"))
    if major != contract.SUPPORTED_MAJOR:
        return CommandVerdict(False, f"unsupported schema {body.get('schema')!r}")

    issued_by = body.get("issuedBy")
    if bound_controller is not None and issued_by != bound_controller:
        # THE check. We are bound to one controller; anything else is either a
        # second controller or a replayed message, and both must be refused.
        return CommandVerdict(
            False,
            f"issuedBy {issued_by!r} is not the bound controller {bound_controller!r}",
            contract.AlarmCode.CONTROLLER_CONFLICT,
        )

    expires_at = body.get("expiresAt")
    if not isinstance(expires_at, str):
        return CommandVerdict(False, "command has no expiresAt")
    try:
        deadline = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return CommandVerdict(False, f"unparseable expiresAt {expires_at!r}")
    if deadline < now:
        return CommandVerdict(False, "command expired", contract.AlarmCode.COMMAND_EXPIRED)

    if not isinstance(body.get("lines"), list) or not body["lines"]:
        return CommandVerdict(False, "command has no lines")
    if not isinstance(body.get("id"), str):
        return CommandVerdict(False, "command has no id")

    return CommandVerdict(True)


class Agent:
    def __init__(self, config: AgentConfig, client, sensor, gpio, clock=time.monotonic):
        self.config = config
        self.client = client
        self.sensor = sensor
        self.gpio = gpio
        self._clock = clock
        self.boot_id = f"boot-{uuid.uuid4().hex[:12]}"
        self.seq = 0
        self.bound_controller: str | None = None
        self.last_heartbeat: float | None = None
        self.deadman_tripped = False

    # ---------------------------------------------------------------- announce

    def capabilities(self) -> dict:
        caps: dict = {
            "contractVersion": contract.SUPPORTED_MAJOR,
            "sensors": [
                {
                    "sensorId": self.config.sensor.sensor_id,
                    "kind": "scd4x",
                    "metrics": ["temperature", "humidity", "co2"],
                    "sampleIntervalMs": int(self.config.sensor.sample_interval_s * 1000),
                }
            ],
            "hasRtc": True,
        }
        # Omitted entirely when there are no lines. This is what makes a
        # sensor-only node unable to be given a device by the server.
        if self.config.has_gpio:
            caps["gpio"] = {"pins": list(self.config.gpio.lines), "supportsReadback": True}
        return caps

    def hello_payload(self) -> dict:
        return {
            "schema": contract.SCHEMAS["hello"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "kind": self.config.kind,
            "agentVersion": self.config.agent_version,
            "bootId": self.boot_id,
            "capabilities": self.capabilities(),
        }

    def status_payload(self, state: str) -> dict:
        return {
            "schema": contract.SCHEMAS["status"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "state": state,
        }

    def sample_payload(self, reading: sensor_mod.Reading) -> dict:
        self.seq += 1
        return {
            "schema": contract.SCHEMAS["sample"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "seq": self.seq,
            "sensor": self.config.sensor.sensor_id,
            "measurements": {
                "co2Ppm": _measurement(reading.co2_ppm),
                "tempC": _measurement(reading.temperature_c),
                "humidityPct": _measurement(reading.humidity_pct),
            },
            "sensorStatus": {"ok": True, "consecutiveFailures": 0, "lastSuccessTs": now_iso()},
        }

    def alarm_payload(self, code: str, severity: str, message: str) -> dict:
        return {
            "schema": contract.SCHEMAS["alarm"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "code": code,
            "severity": severity,
            "message": message,
        }

    # ----------------------------------------------------------------- commands

    def on_command(self, payload: bytes, retained: bool) -> dict | None:
        """Judge a `gpio/set` and, if it passes, apply it. Returns the result."""
        verdict = judge_command(
            payload,
            retained=retained,
            bound_controller=self.bound_controller,
            now=datetime.now(UTC),
        )
        if not verdict.accept:
            if verdict.alarm:
                log.error("refused a command: %s", verdict.reason)
                self.publish_alarm(verdict.alarm, "critical", verdict.reason or "refused")
            else:
                log.debug("ignored a command: %s", verdict.reason)
            return None

        body = json.loads(payload)
        lines = []
        ok = True
        for line in body["lines"]:
            pin, level = int(line["pin"]), int(line["level"])
            try:
                self.gpio.write(pin, level)
                readback = self.gpio.level(pin)
            except Exception as err:  # noqa: BLE001 - reported, never swallowed
                log.error("pin %s could not be driven: %s", pin, err)
                lines.append(
                    {
                        "pin": pin,
                        "requested": level,
                        "readback": None,
                        "ok": False,
                        "error": str(err),
                    }
                )
                ok = False
                continue
            # A readback that disagrees is a failure, and so is one we could not
            # take: unknown state on a burner relay must not be reported as done.
            good = readback == level
            if not good:
                ok = False
            lines.append({"pin": pin, "requested": level, "readback": readback, "ok": good})

        return {
            "schema": contract.SCHEMAS["gpioResult"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "id": body["id"],
            "ok": ok,
            "lines": lines,
        }

    def on_heartbeat(self, payload: bytes) -> None:
        """Bind to the controller that is talking to us, and reset the dead-man."""
        try:
            body = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        controller = body.get("controller")
        if isinstance(controller, str) and controller != self.bound_controller:
            log.warning("bound to controller %s (epoch %s)", controller, body.get("epoch"))
            self.bound_controller = controller
        self.last_heartbeat = self._clock()
        if self.deadman_tripped:
            self.deadman_tripped = False
            self.publish_alarm(contract.AlarmCode.DEADMAN_CLEARED, "info", "heartbeats resumed")

    def check_deadman(self) -> bool:
        """Fail safe locally when the brain goes quiet. Returns True if it trips.

        No server involvement by design: this has to work when the brain is gone
        entirely, which is the one case where nobody else can help.
        """
        if self.last_heartbeat is None or self.deadman_tripped:
            return False
        if self._clock() - self.last_heartbeat < self.config.deadman_s:
            return False

        self.deadman_tripped = True
        log.error("no heartbeat for %.0fs - entering failsafe", self.config.deadman_s)
        self.gpio.failsafe()
        self.publish_alarm(
            contract.AlarmCode.DEADMAN_TRIPPED,
            "critical",
            f"no controller heartbeat for {self.config.deadman_s:.0f}s",
        )
        return True

    # ----------------------------------------------------------------- publish

    def publish_alarm(self, code: str, severity: str, message: str) -> None:
        qos, retain = contract.QOS["alarm"]
        self.client.publish(
            contract.topic_alarm(self.config.node_id),
            json.dumps(self.alarm_payload(code, severity, message)),
            qos=qos,
            retain=retain,
        )


def _measurement(m: sensor_mod.Measurement) -> dict:
    out: dict = {"value": m.value, "valid": m.valid, "unit": m.unit}
    if m.reason:
        out["reason"] = m.reason
    return out


def build_backends(config: AgentConfig, simulated: bool):
    """Wire the sensor and GPIO backends the configuration asks for."""
    gpio = gpio_mod.build(config.gpio.lines, config.gpio.chip_label, simulated)
    gpio.claim(config.gpio.lines, config.gpio.failsafe)

    if config.sensor.kind == "simulated" or simulated:
        sensor = sensor_mod.SimulatedSensor(gpio=gpio if config.has_gpio else None)
    else:
        sensor = sensor_mod.Scd4xSensor(
            bus=config.sensor.bus,
            address=config.sensor.address,
            offset_c=config.sensor.temperature_offset_c,
            altitude_m=config.sensor.altitude_m,
        )
    return sensor, gpio
