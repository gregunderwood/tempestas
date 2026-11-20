"""Agent configuration: a TOML file, with environment overrides.

The one field worth reading carefully is `gpio.lines`. **Empty means this agent
has no GPIO at all**: it advertises no `gpio` capability, so the server refuses
to create a device on it and can never address a pin here, and the chip is never
opened. That is the Stage B posture - a sensor node that physically cannot drive
a relay - and it is enforced by the absence of a backend rather than by a flag
somebody could flip by accident.
"""

from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


class ConfigError(ValueError):
    """A configuration that would be unsafe or ambiguous to run with."""


@dataclass(frozen=True)
class MqttConfig:
    url: str = "mqtt://127.0.0.1:1883"
    username: str | None = None
    password: str | None = None
    keepalive_s: int = 30

    @property
    def host(self) -> str:
        return self.url.split("://", 1)[-1].split(":")[0]

    @property
    def port(self) -> int:
        tail = self.url.split("://", 1)[-1]
        return int(tail.split(":")[1]) if ":" in tail else 1883


# A sensor id is an MQTT topic segment and the tail of a `sensor:<node>/<id>`
# rule source. Narrower than MQTT allows, so it also reads well in a log line.
SENSOR_ID = re.compile(r"^[A-Za-z0-9_.-]+$")
DS18B20_ROM = re.compile(r"^28-[0-9a-f]{12}$")
SENSOR_KINDS = ("scd4x", "simulated", "world", "ds18b20")


@dataclass(frozen=True)
class ProbeConfig:
    """One DS18B20, named by the ROM id it carries rather than by bus order."""

    rom: str
    sensor_id: str


@dataclass(frozen=True)
class SensorConfig:
    kind: str = "scd4x"  # scd4x | simulated | world | ds18b20
    sensor_id: str = "scd4x-0"
    bus: int = 1
    address: int = 0x62
    sample_interval_s: float = 10.0
    # Applied at EVERY startup, never trusted to persist: the Adafruit setter
    # does not call persist_settings, so the value on a sensor has almost
    # certainly been reset by every power cycle since somebody set it.
    temperature_offset_c: float | None = None
    altitude_m: int | None = None
    # Outside these, a word is treated as the sensor having no answer rather
    # than as a measurement. Config rather than constants because they describe
    # THIS greenhouse as much as the chip.
    #
    # 300, not 400. A floor at outdoor air is too aggressive in both directions:
    # a crop in a closed house genuinely depletes below 400 - that is the reason
    # to enrich at all - and a sensor reading somewhat low then goes silent
    # instead of merely inaccurate, which is a worse failure to diagnose. On
    # 2026-09-14 elantris converged on exactly 400 and everything beneath it
    # vanished, leaving no way to tell a dead sensor from a miscalibrated one.
    #
    # Below 300 stays refused: that is not a greenhouse reading by any mechanism
    # here, and a spuriously low value is the direction that calls for CO2.
    co2_min_ppm: int = 300
    # The SCD4x's specified range ends at 5000. It can EMIT up to 40000, which
    # is how a failing one produced 15,723 ppm and had it stored as real.
    co2_max_ppm: int = 5000
    # Sensirion ship ASC enabled. It assumes the space returns to ~400 ppm
    # regularly, which an enriched greenhouse never does, so it revises the
    # baseline toward a number the air never reaches and the sensor reads
    # progressively low - silently, and in the direction that calls for more
    # CO2. Off by default here; a sensor-only node in unenriched air may want
    # it on, and then it needs no manual recalibration.
    automatic_self_calibration: bool = False
    # Refuse readings that CHANGE faster than the greenhouse physically can.
    # The range guard sees impossible values; this sees impossible changes,
    # which is how a degrading sensor produces plausible numbers at impossible
    # speeds.
    #
    # Calibrated against a known-good day rather than from theory: per-sample
    # rates on a HEALTHY sensor reach 285 ppm/min at p99 and peak near 390,
    # because a 10-second window amplifies quantisation noise. 400 refuses
    # nothing on the clean day and 1.1% on a degraded one. Zero disables it.
    co2_max_change_ppm_per_min: float = 400.0
    # ds18b20 only. Each probe becomes its own sensor; `sensor_id` above is
    # unused for this kind, because there is no single sensor to name.
    probes: tuple[ProbeConfig, ...] = ()
    w1_root: str = "/sys/bus/w1/devices"
    # A probe on a pipe cannot move this fast; a glitch can. Zero disables it.
    temperature_max_change_c_per_min: float = 10.0


@dataclass(frozen=True)
class GpioConfig:
    # EMPTY means no GPIO capability at all, and no chip is ever opened.
    lines: tuple[int, ...] = ()
    # Selected by LABEL, never by number: /dev/gpiochip4 is a compatibility
    # symlink on a Pi 4 and a real chip on a Pi 5. One build, both boards.
    chip_label: str = "pinctrl-bcm2711"
    # The level each line takes when the controller is gone. It lives here, on
    # the node, because when the server is gone there is nobody to ask what
    # "safe" means.
    failsafe: dict[int, int] = field(default_factory=dict)


@dataclass(frozen=True)
class WorldConfig:
    """Points the agent at the shared greenhouse simulator instead of hardware.

    A sandbox concern only - `url` unset means this is a real node and neither
    backend is ever constructed. It sits beside sensor/gpio rather than inside
    them because ONE simulator serves both: the burner a node drives and the
    CO2 its sensor then reads are the same greenhouse.
    """

    url: str | None = None
    # Which point in the greenhouse this node's sensor occupies. Not cosmetic:
    # entrance and canopy differ by ~143 ppm, most of a dead band.
    position: str = "entrance"


@dataclass(frozen=True)
class AgentConfig:
    node_id: str
    kind: str = "rpi"
    agent_version: str = "0.1.0"
    mqtt: MqttConfig = field(default_factory=MqttConfig)
    sensor: SensorConfig = field(default_factory=SensorConfig)
    gpio: GpioConfig = field(default_factory=GpioConfig)
    world: WorldConfig = field(default_factory=WorldConfig)
    # No heartbeat for this long and the node fails safe by itself, with no
    # server involvement. See docs/Safety.md - the burner's hold is longer at
    # night because it is also the heater.
    deadman_s: float = 30.0

    @property
    def has_gpio(self) -> bool:
        return len(self.gpio.lines) > 0


def load(path: str | Path | None = None, env: dict[str, str] | None = None) -> AgentConfig:
    """Load from TOML then apply environment overrides."""
    env = os.environ if env is None else env
    raw: dict = {}
    if path is not None:
        raw = tomllib.loads(Path(path).read_text())

    node_id = env.get("TEMPESTAS_NODE_ID") or raw.get("node_id")
    if not node_id:
        # There is no sensible default. A node's slug is its MQTT topic segment
        # and its ACL subject; guessing one would put a node on somebody else's
        # topics.
        raise ConfigError("node_id is required (TEMPESTAS_NODE_ID or node_id in the config file)")

    mqtt_raw = raw.get("mqtt", {})
    mqtt = MqttConfig(
        url=env.get("MQTT_URL") or mqtt_raw.get("url", MqttConfig.url),
        username=env.get("MQTT_USERNAME") or mqtt_raw.get("username"),
        password=env.get("MQTT_PASSWORD") or mqtt_raw.get("password"),
        keepalive_s=int(mqtt_raw.get("keepalive_s", MqttConfig.keepalive_s)),
    )

    sensor_raw = raw.get("sensor", {})
    sensor = SensorConfig(
        kind=env.get("TEMPESTAS_SENSOR_KIND") or sensor_raw.get("kind", SensorConfig.kind),
        sensor_id=sensor_raw.get("sensor_id", SensorConfig.sensor_id),
        bus=int(sensor_raw.get("bus", SensorConfig.bus)),
        address=int(sensor_raw.get("address", SensorConfig.address)),
        sample_interval_s=float(
            sensor_raw.get("sample_interval_s", SensorConfig.sample_interval_s)
        ),
        temperature_offset_c=sensor_raw.get("temperature_offset_c"),
        altitude_m=sensor_raw.get("altitude_m"),
        co2_min_ppm=int(sensor_raw.get("co2_min_ppm", SensorConfig.co2_min_ppm)),
        co2_max_ppm=int(sensor_raw.get("co2_max_ppm", SensorConfig.co2_max_ppm)),
        automatic_self_calibration=bool(
            sensor_raw.get("automatic_self_calibration", SensorConfig.automatic_self_calibration)
        ),
        co2_max_change_ppm_per_min=float(
            sensor_raw.get("co2_max_change_ppm_per_min", SensorConfig.co2_max_change_ppm_per_min)
        ),
        probes=_probes(sensor_raw.get("probes", [])),
        w1_root=sensor_raw.get("w1_root", SensorConfig.w1_root),
        temperature_max_change_c_per_min=float(
            sensor_raw.get(
                "temperature_max_change_c_per_min",
                SensorConfig.temperature_max_change_c_per_min,
            )
        ),
    )
    if sensor.kind not in SENSOR_KINDS:
        kinds = ", ".join(f'"{k}"' for k in SENSOR_KINDS)
        raise ConfigError(f'sensor.kind must be one of {kinds}, not "{sensor.kind}"')
    if sensor.kind == "ds18b20" and not sensor.probes:
        raise ConfigError(
            'sensor.kind = "ds18b20" needs at least one [[sensor.probes]] '
            "with a rom and a sensor_id"
        )
    if sensor.probes and sensor.kind != "ds18b20":
        # Probes on an SCD4x node would be silently ignored, and an ignored
        # pipe probe is a pumphouse nobody is measuring.
        raise ConfigError(f'sensor.probes is only read for kind "ds18b20", not "{sensor.kind}"')
    if sensor.co2_min_ppm >= sensor.co2_max_ppm:
        raise ConfigError(
            f"sensor.co2_min_ppm ({sensor.co2_min_ppm}) must be below "
            f"co2_max_ppm ({sensor.co2_max_ppm})"
        )
    if sensor.sample_interval_s < 5:
        # The SCD4x produces a reading every 5s in periodic mode; asking faster
        # just returns the same one and burns I2C traffic. A DS18B20 takes
        # 750ms per probe per conversion, so three of them need most of 3s.
        raise ConfigError("sensor.sample_interval_s below 5s is pointless for these sensors")

    world_raw = raw.get("world", {})
    world = WorldConfig(
        url=env.get("TEMPESTAS_WORLD_URL") or world_raw.get("url"),
        position=env.get("TEMPESTAS_WORLD_POSITION")
        or world_raw.get("position", WorldConfig.position),
    )
    if sensor.kind == "world" and not world.url:
        raise ConfigError('sensor.kind = "world" needs world.url (or TEMPESTAS_WORLD_URL)')

    gpio_raw = raw.get("gpio", {})
    lines = tuple(int(p) for p in gpio_raw.get("lines", ()))
    failsafe = {int(k): int(v) for k, v in (gpio_raw.get("failsafe") or {}).items()}
    unknown = sorted(set(failsafe) - set(lines))
    if unknown:
        raise ConfigError(f"gpio.failsafe names lines that are not managed: {unknown}")
    missing = sorted(set(lines) - set(failsafe))
    if lines and missing:
        # A managed line with no declared safe level is a line nobody has
        # decided about, on a board where one of them is a propane burner.
        raise ConfigError(f"every managed line needs a gpio.failsafe level; missing: {missing}")

    gpio = GpioConfig(
        lines=lines,
        chip_label=gpio_raw.get("chip_label", GpioConfig.chip_label),
        failsafe=failsafe,
    )

    return AgentConfig(
        node_id=node_id,
        kind=raw.get("kind", "rpi"),
        agent_version=raw.get("agent_version", "0.1.0"),
        mqtt=mqtt,
        sensor=sensor,
        gpio=gpio,
        world=world,
        deadman_s=float(raw.get("deadman_s", 30.0)),
    )


def _probes(raw) -> tuple[ProbeConfig, ...]:
    """Parse `[[sensor.probes]]`, refusing anything ambiguous about which is which."""
    if not isinstance(raw, list):
        raise ConfigError("sensor.probes must be a list of [[sensor.probes]] tables")
    probes = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ConfigError(f"sensor.probes[{i}] must be a table")
        rom = str(entry.get("rom", "")).strip().lower()
        sensor_id = str(entry.get("sensor_id", "")).strip()
        if not DS18B20_ROM.match(rom):
            raise ConfigError(
                f'sensor.probes[{i}].rom "{rom}" is not a DS18B20 ROM id like 28-0123456789ab '
                "(read it from /sys/bus/w1/devices/)"
            )
        if not SENSOR_ID.match(sensor_id):
            raise ConfigError(
                f'sensor.probes[{i}].sensor_id "{sensor_id}" must be letters, digits, '
                '"_", "." or "-"'
            )
        probes.append(ProbeConfig(rom=rom, sensor_id=sensor_id))

    # A duplicated ROM publishes one probe under two names; a duplicated name
    # merges two probes into one sensor whose readings alternate between them.
    for field_name in ("rom", "sensor_id"):
        values = [getattr(p, field_name) for p in probes]
        dupes = sorted({v for v in values if values.count(v) > 1})
        if dupes:
            raise ConfigError(f"sensor.probes repeats a {field_name}: {dupes}")
    return tuple(probes)
