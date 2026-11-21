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

    major = contract.read_schema_major(body.get("schema"))
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
            # One entry per sensor, and only the metrics it actually has. The
            # dashboard draws a gauge per declared metric, so a pipe probe that
            # claimed humidity would show a permanently empty dial.
            "sensors": [
                {
                    "sensorId": info.sensor_id,
                    "kind": info.kind,
                    "metrics": list(info.metrics),
                    "sampleIntervalMs": int(self.config.sensor.sample_interval_s * 1000),
                }
                for info in self.sensor.sensors()
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

    def sample_payload(self, sensor_id: str, reading: sensor_mod.Reading) -> dict:
        # One counter per node, shared by its sensors. The server's dedupe key
        # includes the sensor, so a shared counter is unique where it needs to
        # be and still says, in a log, which order the samples were taken in.
        self.seq += 1
        return {
            "schema": contract.SCHEMAS["sample"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "seq": self.seq,
            "sensor": sensor_id,
            "measurements": {
                "co2Ppm": _measurement(reading.co2_ppm),
                "tempC": _measurement(reading.temperature_c),
                "humidityPct": _measurement(reading.humidity_pct),
            },
            "sensorStatus": {"ok": True, "consecutiveFailures": 0, "lastSuccessTs": now_iso()},
        }

    def gpio_state_payload(self, pin: int) -> dict:
        """What this line IS, read from the pad rather than from intent."""
        level = self.gpio.level(pin)
        return {
            "schema": contract.SCHEMAS["gpioState"],
            "node": self.config.node_id,
            "ts": now_iso(),
            "pin": pin,
            "level": level,
            # An unreadable pad is UNKNOWN, and unknown is not off.
            "known": level in (0, 1),
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

    def enter_failsafe(self, code: str, message: str) -> None:
        """Drive every managed line safe, then TELL the bus what the lines are.

        The order is the point. Hardware first, then the retained `gpio/state`,
        then the alarm - so anything reacting to the alarm already has the truth.

        Publishing the state is not bookkeeping. `gpio/state` is retained, which
        makes it the value a controller reads to reconcile after a restart.
        Failing safe without republishing leaves a retained message on the bus
        saying a burner relay is energised when it is not, and the controller
        then trusts it. Found end to end on real hardware: after the node failed
        safe on the server's LWT, the pad was de-energised while the retained
        state and the device row both still said ON.
        """
        self.gpio.failsafe()
        self.publish_gpio_state(self.config.gpio.lines)
        self.publish_alarm(code, "critical", message)

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
        self.enter_failsafe(
            contract.AlarmCode.DEADMAN_TRIPPED,
            f"no controller heartbeat for {self.config.deadman_s:.0f}s",
        )
        return True

    # ----------------------------------------------------------------- publish

    def publish_gpio_state(self, pins) -> None:
        """Publish the retained `gpio/state` for each pin. Never skipped.

        Retained, so this is what a controller reads on subscribe to find out
        what the lines are doing. Every path that changes a line has to come
        through here or the bus keeps a stale answer indefinitely.
        """
        qos, retain = contract.QOS["gpioState"]
        for pin in pins:
            self.client.publish(
                contract.build_gpio_state_topic(self.config.node_id, pin),
                json.dumps(self.gpio_state_payload(pin)),
                qos=qos,
                retain=retain,
            )

    def publish_alarm(self, code: str, severity: str, message: str) -> None:
        qos, retain = contract.QOS["alarm"]
        self.client.publish(
            contract.build_alarm_topic(self.config.node_id),
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
    world_client = None
    if config.world.url:
        from .world_client import WorldClient

        world_client = WorldClient(config.world.url)

    if world_client is not None and config.gpio.lines:
        gpio = gpio_mod.WorldGpio(config.node_id, world_client)
    else:
        gpio = gpio_mod.build(config.gpio.lines, config.gpio.chip_label, simulated)
    gpio.claim(config.gpio.lines, config.gpio.failsafe)

    if config.sensor.kind == "ds18b20" and not simulated:
        from .ds18b20 import Ds18b20Sensors, Probe

        return (
            Ds18b20Sensors(
                tuple(Probe(p.rom, p.sensor_id) for p in config.sensor.probes),
                w1_root=config.sensor.w1_root,
                max_c_per_min=config.sensor.temperature_max_change_c_per_min,
            ),
            gpio,
        )

    if world_client is not None and config.sensor.kind == "world":
        sensor = sensor_mod.WorldSensor(
            world_client,
            config.world.position,
            offset_c=config.sensor.temperature_offset_c,
        )
    elif config.sensor.kind == "simulated" or simulated:
        sensor = sensor_mod.SimulatedSensor(gpio=gpio if config.has_gpio else None)
    else:
        sensor = sensor_mod.Scd4xSensor(
            bus=config.sensor.bus,
            address=config.sensor.address,
            offset_c=config.sensor.temperature_offset_c,
            altitude_m=config.sensor.altitude_m,
            co2_min=config.sensor.co2_min_ppm,
            co2_max=config.sensor.co2_max_ppm,
            asc_enabled=config.sensor.automatic_self_calibration,
            max_ppm_per_min=config.sensor.co2_max_change_ppm_per_min,
        )
    info = sensor_mod.SensorInfo(
        config.sensor.sensor_id, "scd4x", ("temperature", "humidity", "co2")
    )
    return sensor_mod.SingleSensor(sensor, info), gpio
