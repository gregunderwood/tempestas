"""The greenhouse as one pure object that every agent acts on; see tools/sandbox/README.md."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

ROLE_CO2 = "co2_generator"
ROLE_FAN = "exhaust_fan"
ROLE_HPS = "hps_lights"
ROLE_MH = "mh_light"
ROLE_NONE = "none"

VALID_LEVELS = (0, 1)

MAGNUS_COEFFICIENT_HPA = 6.112
MAGNUS_TEMPERATURE_FACTOR = 17.62
MAGNUS_TEMPERATURE_OFFSET_C = 243.12

MINUTES_PER_DAY = 1440.0
COLDEST_MINUTE_OF_DAY = 300.0

SUBSTEP_MINUTES = 0.5
NEGLIGIBLE_MINUTES = 1e-9

TRANSPIRATION_HPA_PER_MINUTE = 0.02
FAN_VAPOUR_TARGET_HPA = 8.0
FAN_VAPOUR_CLEAR_FRACTION_PER_MINUTE = 0.15
MINIMUM_VAPOUR_HPA = 1.0

DEFAULT_START_ENRICHMENT_PPM = 100
DEFAULT_START_TEMP_C = 15.0
DEFAULT_START_VAPOUR_HPA = 12.0


def saturation_pressure(temp_c: float) -> float:
    """Saturation vapour pressure in hPa, by the Magnus form the docs use."""
    return MAGNUS_COEFFICIENT_HPA * math.exp(
        (MAGNUS_TEMPERATURE_FACTOR * temp_c) / (MAGNUS_TEMPERATURE_OFFSET_C + temp_c)
    )


@dataclass(frozen=True)
class Fixture:
    node_id: str
    pin: int
    role: str
    on_level: int

    @property
    def key(self) -> tuple[str, int]:
        return (self.node_id, self.pin)


@dataclass(frozen=True)
class Site:
    position: str
    co2_gradient_fraction: float
    temp_offset_c: float


@dataclass
class Air:
    co2_ppm: float
    temp_c: float
    # Vapour pressure rather than RH, so sites at different temperatures report different RH.
    vapour_hpa: float


def read_measured_value(section: dict, *path: str) -> float:
    for key in path:
        section = section[key]
    return float(section["value"])


def is_comment_key(name: str) -> bool:
    return name.startswith("$")


@dataclass
class Model:
    outdoor_co2_ppm: float
    leak_fraction_per_minute: float
    thermal_coupling_per_minute: float
    burner_co2_ppm_per_minute: float
    burner_transport_lag_minutes: float
    burner_deg_c_per_minute: float
    fan_clear_fraction_per_minute: float
    fan_temp_pull_per_minute: float
    hps_deg_c_per_minute: float
    mh_deg_c_per_minute: float
    sites: dict[str, Site] = field(default_factory=dict)

    @staticmethod
    def load(path: str | Path) -> Model:
        model_file = json.loads(Path(path).read_text())
        sites = {
            name: Site(
                position=name,
                co2_gradient_fraction=read_measured_value(site_section, "co2_gradient_fraction"),
                temp_offset_c=read_measured_value(site_section, "temp_offset_c"),
            )
            for name, site_section in model_file["sites"].items()
            if not is_comment_key(name)
        }
        return Model(
            outdoor_co2_ppm=read_measured_value(model_file, "air", "outdoor_co2_ppm"),
            leak_fraction_per_minute=read_measured_value(
                model_file, "air", "leak_fraction_per_minute"
            ),
            thermal_coupling_per_minute=read_measured_value(
                model_file, "air", "thermal_coupling_per_minute"
            ),
            burner_co2_ppm_per_minute=read_measured_value(
                model_file, "burner", "co2_ppm_per_minute"
            ),
            burner_transport_lag_minutes=read_measured_value(
                model_file, "burner", "transport_lag_minutes"
            ),
            burner_deg_c_per_minute=read_measured_value(model_file, "burner", "deg_c_per_minute"),
            fan_clear_fraction_per_minute=read_measured_value(
                model_file, "fan", "clear_fraction_per_minute"
            ),
            fan_temp_pull_per_minute=read_measured_value(model_file, "fan", "temp_pull_per_minute"),
            hps_deg_c_per_minute=read_measured_value(model_file, "lights", "hps_deg_c_per_minute"),
            mh_deg_c_per_minute=read_measured_value(model_file, "lights", "mh_deg_c_per_minute"),
            sites=sites,
        )


@dataclass(frozen=True)
class SiteReading:
    co2_ppm: float
    temperature_c: float
    humidity_pct: float


class World:
    def __init__(
        self,
        model: Model,
        fixtures: list[Fixture],
        *,
        air: Air | None = None,
        outdoor_mean_c: float = 12.0,
        outdoor_swing_c: float = 7.0,
    ) -> None:
        self.model = model
        self.fixtures = {fixture.key: fixture for fixture in fixtures}
        self.air = air or Air(
            co2_ppm=model.outdoor_co2_ppm + DEFAULT_START_ENRICHMENT_PPM,
            temp_c=DEFAULT_START_TEMP_C,
            vapour_hpa=DEFAULT_START_VAPOUR_HPA,
        )
        self.outdoor_mean_c = outdoor_mean_c
        self.outdoor_swing_c = outdoor_swing_c
        # Unknown, not off, until written: the rule the real backends follow.
        self.levels: dict[tuple[str, int], int | None] = {fixture.key: None for fixture in fixtures}
        # CO2 produced but not yet mixed to the sensor, which is what makes the burner overshoot.
        self.in_flight_ppm = 0.0

    def set_level(self, node_id: str, pin: int, level: int) -> None:
        key = (node_id, pin)
        if key not in self.levels:
            raise KeyError(f"no fixture wired at {node_id}:{pin}")
        if level not in VALID_LEVELS:
            raise ValueError(f"level must be 0 or 1, not {level!r}")
        self.levels[key] = level

    def energised(self, role: str) -> bool:
        return any(
            self._is_fixture_energised(key, fixture)
            for key, fixture in self.fixtures.items()
            if fixture.role == role
        )

    def _is_fixture_energised(self, key: tuple[str, int], fixture: Fixture) -> bool:
        level = self.levels.get(key)
        return level is not None and level == fixture.on_level

    def outdoor_temp_c(self, minute_of_day: float) -> float:
        phase = ((minute_of_day - COLDEST_MINUTE_OF_DAY) / MINUTES_PER_DAY) * 2.0 * math.pi
        return self.outdoor_mean_c + self.outdoor_swing_c * math.sin(phase)

    def step(self, minutes: float, minute_of_day: float) -> None:
        """Advance the world in sub-steps, so a long jump stays stable."""
        remaining = minutes
        while remaining > NEGLIGIBLE_MINUTES:
            step_minutes = min(remaining, SUBSTEP_MINUTES)
            self._step_once(step_minutes, minute_of_day)
            remaining -= step_minutes

    def _step_once(self, step_minutes: float, minute_of_day: float) -> None:
        outdoor_c = self.outdoor_temp_c(minute_of_day)
        is_burner_on = self.energised(ROLE_CO2)
        is_fan_on = self.energised(ROLE_FAN)

        self._step_co2(step_minutes, is_burner_on, is_fan_on)
        self._step_temperature(step_minutes, outdoor_c, is_burner_on, is_fan_on)
        self._step_moisture(step_minutes, is_fan_on)

    def _step_co2(self, step_minutes: float, is_burner_on: bool, is_fan_on: bool) -> None:
        model = self.model
        if is_burner_on:
            self.in_flight_ppm += model.burner_co2_ppm_per_minute * step_minutes
        drained = self.in_flight_ppm * (
            1.0 - math.exp(-step_minutes / model.burner_transport_lag_minutes)
        )
        self.in_flight_ppm -= drained

        enrichment = self.air.co2_ppm - model.outdoor_co2_ppm
        self.air.co2_ppm -= enrichment * model.leak_fraction_per_minute * step_minutes
        self.air.co2_ppm += drained
        if is_fan_on:
            self.air.co2_ppm -= (
                (self.air.co2_ppm - model.outdoor_co2_ppm)
                * model.fan_clear_fraction_per_minute
                * step_minutes
            )
        self.air.co2_ppm = max(model.outdoor_co2_ppm, self.air.co2_ppm)

    def _step_temperature(
        self, step_minutes: float, outdoor_c: float, is_burner_on: bool, is_fan_on: bool
    ) -> None:
        model = self.model
        self.air.temp_c += (
            (outdoor_c - self.air.temp_c) * model.thermal_coupling_per_minute * step_minutes
        )
        if is_burner_on:
            self.air.temp_c += model.burner_deg_c_per_minute * step_minutes
        if self.energised(ROLE_HPS):
            self.air.temp_c += model.hps_deg_c_per_minute * step_minutes
        if self.energised(ROLE_MH):
            self.air.temp_c += model.mh_deg_c_per_minute * step_minutes
        if is_fan_on:
            self.air.temp_c += (
                (outdoor_c - self.air.temp_c) * model.fan_temp_pull_per_minute * step_minutes
            )

    def _step_moisture(self, step_minutes: float, is_fan_on: bool) -> None:
        self.air.vapour_hpa += TRANSPIRATION_HPA_PER_MINUTE * step_minutes
        if is_fan_on:
            self.air.vapour_hpa -= (
                (self.air.vapour_hpa - FAN_VAPOUR_TARGET_HPA)
                * FAN_VAPOUR_CLEAR_FRACTION_PER_MINUTE
                * step_minutes
            )
        ceiling = saturation_pressure(self.air.temp_c)
        self.air.vapour_hpa = max(MINIMUM_VAPOUR_HPA, min(ceiling, self.air.vapour_hpa))

    def read(self, position: str) -> SiteReading:
        site = self.model.sites[position]
        temp_c = self.air.temp_c + site.temp_offset_c
        # Scaled by enrichment, not a flat offset, so no site reads below outdoor air at rest.
        enrichment = max(0.0, self.air.co2_ppm - self.model.outdoor_co2_ppm)
        co2_ppm = self.model.outdoor_co2_ppm + enrichment * (1.0 + site.co2_gradient_fraction)
        humidity_pct = 100.0 * self.air.vapour_hpa / saturation_pressure(temp_c)
        return SiteReading(
            co2_ppm=round(co2_ppm, 1),
            temperature_c=round(temp_c, 2),
            humidity_pct=round(max(0.0, min(100.0, humidity_pct)), 2),
        )
