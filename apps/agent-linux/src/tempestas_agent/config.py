"""Agent configuration: a TOML file, with environment overrides."""

from __future__ import annotations

import os
import re
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .ds18b20 import ROM_PATTERN, W1_ROOT

DEFAULT_MQTT_PORT = 1883
URL_SCHEME_SEPARATOR = "://"
# An MQTT topic segment, narrower than MQTT allows so it also reads well in a log line.
SENSOR_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
SENSOR_KINDS = ("scd4x", "simulated", "world", "ds18b20")
# The SCD4x reads every 5 s; three DS18B20 conversions take most of 3 s.
MIN_SAMPLE_INTERVAL_S = 5


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
        return self._authority.split(":")[0]

    @property
    def port(self) -> int:
        authority = self._authority
        return int(authority.split(":")[1]) if ":" in authority else DEFAULT_MQTT_PORT

    @property
    def _authority(self) -> str:
        return self.url.split(URL_SCHEME_SEPARATOR, 1)[-1]


@dataclass(frozen=True)
class ProbeConfig:
    """One DS18B20, named by the ROM id it carries rather than by bus order."""

    rom: str
    sensor_id: str


@dataclass(frozen=True)
class SensorConfig:
    kind: str = "scd4x"
    sensor_id: str = "scd4x-0"
    bus: int = 1
    address: int = 0x62
    sample_interval_s: float = 10.0
    temperature_offset_c: float | None = None
    altitude_m: int | None = None
    co2_min_ppm: int = 300
    co2_max_ppm: int = 5000
    automatic_self_calibration: bool = False
    co2_max_change_ppm_per_min: float = 400.0
    probes: tuple[ProbeConfig, ...] = ()
    w1_root: str = W1_ROOT
    temperature_max_change_c_per_min: float = 10.0


@dataclass(frozen=True)
class GpioConfig:
    lines: tuple[int, ...] = ()
    # By label, never number: /dev/gpiochip4 is a symlink on a Pi 4 and a real chip on a Pi 5.
    chip_label: str = "pinctrl-bcm2711"
    # Lives on the node, because when the server is gone there is nobody to ask what safe means.
    failsafe: dict[int, int] = field(default_factory=dict)


@dataclass(frozen=True)
class WorldConfig:
    """The shared greenhouse simulator; `url` unset means a real node."""

    url: str | None = None
    position: str = "entrance"


@dataclass(frozen=True)
class AgentConfig:
    node_id: str
    kind: str = "rpi"
    mqtt: MqttConfig = field(default_factory=MqttConfig)
    sensor: SensorConfig = field(default_factory=SensorConfig)
    gpio: GpioConfig = field(default_factory=GpioConfig)
    world: WorldConfig = field(default_factory=WorldConfig)
    deadman_s: float = 30.0

    @property
    def has_gpio(self) -> bool:
        return len(self.gpio.lines) > 0


def load(path: str | Path | None = None, environment: dict[str, str] | None = None) -> AgentConfig:
    """Load from TOML then apply environment overrides."""
    environment = os.environ if environment is None else environment
    document = tomllib.loads(Path(path).read_text()) if path is not None else {}

    node_id = _read_node_id(document, environment)
    mqtt = _read_mqtt(document.get("mqtt", {}), environment)
    sensor = _read_sensor(document.get("sensor", {}), environment)
    _validate_sensor(sensor)
    world = _read_world(document.get("world", {}), environment)
    if sensor.kind == "world" and not world.url:
        raise ConfigError('sensor.kind = "world" needs world.url (or TEMPESTAS_WORLD_URL)')
    gpio = _read_gpio(document.get("gpio", {}))

    return AgentConfig(
        node_id=node_id,
        kind=document.get("kind", AgentConfig.kind),
        mqtt=mqtt,
        sensor=sensor,
        gpio=gpio,
        world=world,
        deadman_s=float(document.get("deadman_s", AgentConfig.deadman_s)),
    )


def _read_setting(section: dict, defaults: type, key: str, convert: Callable = lambda value: value):
    return convert(section.get(key, getattr(defaults, key)))


def _read_node_id(document: dict, environment) -> str:
    node_id = environment.get("TEMPESTAS_NODE_ID") or document.get("node_id")
    if not node_id:
        # A slug is a topic segment and an ACL subject; guessing one lands on another node's topics.
        raise ConfigError("node_id is required (TEMPESTAS_NODE_ID or node_id in the config file)")
    return node_id


def _read_mqtt(section: dict, environment) -> MqttConfig:
    return MqttConfig(
        url=environment.get("MQTT_URL") or _read_setting(section, MqttConfig, "url"),
        username=environment.get("MQTT_USERNAME") or section.get("username"),
        password=environment.get("MQTT_PASSWORD") or section.get("password"),
        keepalive_s=_read_setting(section, MqttConfig, "keepalive_s", int),
    )


def _read_sensor(section: dict, environment) -> SensorConfig:
    def read(key: str, convert: Callable = lambda value: value):
        return _read_setting(section, SensorConfig, key, convert)

    return SensorConfig(
        kind=environment.get("TEMPESTAS_SENSOR_KIND") or read("kind"),
        sensor_id=read("sensor_id"),
        bus=read("bus", int),
        address=read("address", int),
        sample_interval_s=read("sample_interval_s", float),
        temperature_offset_c=read("temperature_offset_c"),
        altitude_m=read("altitude_m"),
        co2_min_ppm=read("co2_min_ppm", int),
        co2_max_ppm=read("co2_max_ppm", int),
        automatic_self_calibration=read("automatic_self_calibration", bool),
        co2_max_change_ppm_per_min=read("co2_max_change_ppm_per_min", float),
        probes=_parse_probes(section.get("probes", [])),
        w1_root=read("w1_root"),
        temperature_max_change_c_per_min=read("temperature_max_change_c_per_min", float),
    )


def _validate_sensor(sensor: SensorConfig) -> None:
    if sensor.kind not in SENSOR_KINDS:
        kinds = ", ".join(f'"{kind}"' for kind in SENSOR_KINDS)
        raise ConfigError(f'sensor.kind must be one of {kinds}, not "{sensor.kind}"')
    if sensor.kind == "ds18b20" and not sensor.probes:
        raise ConfigError(
            'sensor.kind = "ds18b20" needs at least one [[sensor.probes]] '
            "with a rom and a sensor_id"
        )
    if sensor.probes and sensor.kind != "ds18b20":
        # An ignored pipe probe is a pumphouse nobody is measuring.
        raise ConfigError(f'sensor.probes is only read for kind "ds18b20", not "{sensor.kind}"')
    if sensor.co2_min_ppm >= sensor.co2_max_ppm:
        raise ConfigError(
            f"sensor.co2_min_ppm ({sensor.co2_min_ppm}) must be below "
            f"co2_max_ppm ({sensor.co2_max_ppm})"
        )
    if sensor.sample_interval_s < MIN_SAMPLE_INTERVAL_S:
        raise ConfigError("sensor.sample_interval_s below 5s is pointless for these sensors")


def _read_world(section: dict, environment) -> WorldConfig:
    return WorldConfig(
        url=environment.get("TEMPESTAS_WORLD_URL") or section.get("url"),
        position=environment.get("TEMPESTAS_WORLD_POSITION")
        or _read_setting(section, WorldConfig, "position"),
    )


def _read_gpio(section: dict) -> GpioConfig:
    lines = tuple(int(pin) for pin in section.get("lines", ()))
    failsafe = {int(pin): int(level) for pin, level in (section.get("failsafe") or {}).items()}
    unmanaged = sorted(set(failsafe) - set(lines))
    if unmanaged:
        raise ConfigError(f"gpio.failsafe names lines that are not managed: {unmanaged}")
    undecided = sorted(set(lines) - set(failsafe))
    if lines and undecided:
        # A line nobody has decided about, on a board where one of them is a propane burner.
        raise ConfigError(f"every managed line needs a gpio.failsafe level; missing: {undecided}")
    return GpioConfig(
        lines=lines,
        chip_label=_read_setting(section, GpioConfig, "chip_label"),
        failsafe=failsafe,
    )


def _parse_probes(entries) -> tuple[ProbeConfig, ...]:
    if not isinstance(entries, list):
        raise ConfigError("sensor.probes must be a list of [[sensor.probes]] tables")
    probes = tuple(_parse_probe(index, entry) for index, entry in enumerate(entries))
    _refuse_repeated_probe_fields(probes)
    return probes


def _parse_probe(index: int, entry) -> ProbeConfig:
    if not isinstance(entry, dict):
        raise ConfigError(f"sensor.probes[{index}] must be a table")
    rom = str(entry.get("rom", "")).strip().lower()
    sensor_id = str(entry.get("sensor_id", "")).strip()
    if not ROM_PATTERN.match(rom):
        raise ConfigError(
            f'sensor.probes[{index}].rom "{rom}" is not a DS18B20 ROM id like 28-0123456789ab '
            "(read it from /sys/bus/w1/devices/)"
        )
    if not SENSOR_ID_PATTERN.match(sensor_id):
        raise ConfigError(
            f'sensor.probes[{index}].sensor_id "{sensor_id}" must be letters, digits, '
            '"_", "." or "-"'
        )
    return ProbeConfig(rom=rom, sensor_id=sensor_id)


def _refuse_repeated_probe_fields(probes: tuple[ProbeConfig, ...]) -> None:
    # A repeated ROM publishes one probe twice; a repeated name merges two probes into one sensor.
    for field_name in ("rom", "sensor_id"):
        values = [getattr(probe, field_name) for probe in probes]
        repeated = sorted({value for value in values if values.count(value) > 1})
        if repeated:
            raise ConfigError(f"sensor.probes repeats a {field_name}: {repeated}")
