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


@dataclass(frozen=True)
class SensorConfig:
    kind: str = "scd4x"  # scd4x | simulated
    sensor_id: str = "scd4x-0"
    bus: int = 1
    address: int = 0x62
    sample_interval_s: float = 10.0
    # Applied at EVERY startup, never trusted to persist: the Adafruit setter
    # does not call persist_settings, so the value on a sensor has almost
    # certainly been reset by every power cycle since somebody set it.
    temperature_offset_c: float | None = None
    altitude_m: int | None = None


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
class AgentConfig:
    node_id: str
    kind: str = "rpi"
    agent_version: str = "0.1.0"
    mqtt: MqttConfig = field(default_factory=MqttConfig)
    sensor: SensorConfig = field(default_factory=SensorConfig)
    gpio: GpioConfig = field(default_factory=GpioConfig)
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
    )
    if sensor.kind not in {"scd4x", "simulated"}:
        raise ConfigError(f'sensor.kind must be "scd4x" or "simulated", not "{sensor.kind}"')
    if sensor.sample_interval_s < 5:
        # The SCD4x produces a reading every 5s in periodic mode; asking faster
        # just returns the same one and burns I2C traffic.
        raise ConfigError("sensor.sample_interval_s below 5s is pointless for an SCD4x")

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
        deadman_s=float(raw.get("deadman_s", 30.0)),
    )
