"""The greenhouse, as one object that both agents act on.

Pure: no I/O, no clock of its own, no HTTP. `step()` takes the elapsed minutes
and the current wall time, so every test is deterministic and the whole model
can be exercised without a server.

The point of a SHARED world is the thing a per-agent simulator cannot do: two
boxes at opposite ends of one greenhouse, where elantris's burner changes what
greenhouse's sensor reads. That coupling is the multi-controller problem in
miniature, so a simulator that gives each agent its own private air would
silently pass the tests that matter most.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

# Roles a line can drive. `NONE` is not padding: two of the greenhouse's five
# lines drive nothing, and the sandbox has to reproduce that or it will not
# catch a command routed to a channel that goes nowhere.
ROLE_CO2 = "co2_generator"
ROLE_FAN = "exhaust_fan"
ROLE_HPS = "hps_lights"
ROLE_MH = "mh_light"
ROLE_NONE = "none"


def saturation_pressure(temp_c: float) -> float:
    """Saturation vapour pressure, hPa. Magnus, the form the docs use."""
    return 6.112 * math.exp((17.62 * temp_c) / (243.12 + temp_c))


@dataclass(frozen=True)
class Fixture:
    """One relay-driven load, wired exactly as the real greenhouse is.

    `on_level` is per fixture and not a board constant. The greenhouse runs
    four active-LOW channels and one active-HIGH module on BCM 26, and getting
    that backwards in the simulator would hide the single most dangerous
    migration bug there is.
    """

    node_id: str
    pin: int
    role: str
    on_level: int

    @property
    def key(self) -> tuple[str, int]:
        return (self.node_id, self.pin)


@dataclass(frozen=True)
class Site:
    """Where a sensor sits, and how that spot differs from the bulk air."""

    position: str
    # Fraction of the enrichment above outdoor, +/-. Derived from the paired
    # sample: 143 ppm apart at ~690 ppm of enrichment, so +-10.4%.
    co2_gradient_fraction: float
    temp_offset_c: float


@dataclass
class Air:
    """Bulk state. Humidity is carried as vapour pressure, not RH.

    RH is a function of temperature, so two sensors in the same air at
    different indicated temperatures MUST report different RH. Storing the
    vapour pressure and deriving RH per site reproduces that for free - and it
    is exactly what the paired sample showed: 64.9% and 52.4% RH, 16.08 and
    16.48 hPa. Storing RH directly would model the artefact as if it were real.
    """

    co2_ppm: float
    temp_c: float
    vapour_hpa: float


def _v(node: dict, *path: str) -> float:
    """Pull a value out of the provenance-carrying model file."""
    cur = node
    for p in path:
        cur = cur[p]
    return float(cur["value"])


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
        raw = json.loads(Path(path).read_text())
        sites = {
            name: Site(
                position=name,
                co2_gradient_fraction=_v(cfg, "co2_gradient_fraction"),
                temp_offset_c=_v(cfg, "temp_offset_c"),
            )
            for name, cfg in raw["sites"].items()
            if not name.startswith("$")
        }
        return Model(
            outdoor_co2_ppm=_v(raw, "air", "outdoor_co2_ppm"),
            leak_fraction_per_minute=_v(raw, "air", "leak_fraction_per_minute"),
            thermal_coupling_per_minute=_v(raw, "air", "thermal_coupling_per_minute"),
            burner_co2_ppm_per_minute=_v(raw, "burner", "co2_ppm_per_minute"),
            burner_transport_lag_minutes=_v(raw, "burner", "transport_lag_minutes"),
            burner_deg_c_per_minute=_v(raw, "burner", "deg_c_per_minute"),
            fan_clear_fraction_per_minute=_v(raw, "fan", "clear_fraction_per_minute"),
            fan_temp_pull_per_minute=_v(raw, "fan", "temp_pull_per_minute"),
            hps_deg_c_per_minute=_v(raw, "lights", "hps_deg_c_per_minute"),
            mh_deg_c_per_minute=_v(raw, "lights", "mh_deg_c_per_minute"),
            sites=sites,
        )


@dataclass(frozen=True)
class SiteReading:
    co2_ppm: float
    temperature_c: float
    humidity_pct: float


class World:
    """One greenhouse. Many nodes write to it; many sensors read from it."""

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
        self.fixtures = {f.key: f for f in fixtures}
        self.air = air or Air(co2_ppm=model.outdoor_co2_ppm + 100, temp_c=15.0, vapour_hpa=12.0)
        self.outdoor_mean_c = outdoor_mean_c
        self.outdoor_swing_c = outdoor_swing_c
        # A line nobody has written is UNKNOWN, not off - the same rule the
        # real backends follow. Assuming off here would let the sandbox pass a
        # test that real hardware fails.
        self.levels: dict[tuple[str, int], int | None] = {f.key: None for f in fixtures}
        # CO2 produced but not yet mixed to the sensor. This one reservoir is
        # why the burner appears to do nothing for the first couple of minutes
        # AND why the level keeps climbing after it is commanded off.
        self._in_flight_ppm = 0.0

    # ---------------------------------------------------------------- inputs

    def set_level(self, node_id: str, pin: int, level: int) -> None:
        key = (node_id, pin)
        if key not in self.levels:
            raise KeyError(f"no fixture wired at {node_id}:{pin}")
        if level not in (0, 1):
            raise ValueError(f"level must be 0 or 1, not {level!r}")
        self.levels[key] = level

    def energised(self, role: str) -> bool:
        """True when ANY fixture in that role is on, polarity respected."""
        for key, fixture in self.fixtures.items():
            if fixture.role != role:
                continue
            level = self.levels.get(key)
            if level is not None and level == fixture.on_level:
                return True
        return False

    # --------------------------------------------------------------- physics

    def outdoor_temp_c(self, minute_of_day: float) -> float:
        """Coldest before dawn, warmest mid-afternoon."""
        phase = ((minute_of_day - 300.0) / 1440.0) * 2.0 * math.pi
        return self.outdoor_mean_c + self.outdoor_swing_c * math.sin(phase)

    def step(self, minutes: float, minute_of_day: float) -> None:
        """Advance the world. Sub-stepped so a long jump stays stable."""
        remaining = minutes
        while remaining > 1e-9:
            dt = min(remaining, 0.5)
            self._step_once(dt, minute_of_day)
            remaining -= dt

    def _step_once(self, dt: float, minute_of_day: float) -> None:
        m = self.model
        outdoor_c = self.outdoor_temp_c(minute_of_day)

        burner = self.energised(ROLE_CO2)
        fan = self.energised(ROLE_FAN)

        # --- CO2 -------------------------------------------------------
        # Production goes into a reservoir that drains to the measured air
        # with a time constant, rather than appearing at the sensor instantly.
        # A threshold-style "warm-up" would model only the rising edge and
        # would make the burner stop dead on command, which is not what the
        # greenhouse does: it overshot the 1500 ppm cut-off by 46-103 ppm on
        # every one of the four cycles measured.
        if burner:
            self._in_flight_ppm += m.burner_co2_ppm_per_minute * dt
        drained = self._in_flight_ppm * (1.0 - math.exp(-dt / m.burner_transport_lag_minutes))
        self._in_flight_ppm -= drained

        gradient = self.air.co2_ppm - m.outdoor_co2_ppm
        self.air.co2_ppm -= gradient * m.leak_fraction_per_minute * dt
        self.air.co2_ppm += drained
        if fan:
            self.air.co2_ppm -= (
                (self.air.co2_ppm - m.outdoor_co2_ppm) * m.fan_clear_fraction_per_minute * dt
            )
        self.air.co2_ppm = max(m.outdoor_co2_ppm, self.air.co2_ppm)

        # --- temperature ------------------------------------------------
        self.air.temp_c += (outdoor_c - self.air.temp_c) * m.thermal_coupling_per_minute * dt
        if burner:
            self.air.temp_c += m.burner_deg_c_per_minute * dt
        if self.energised(ROLE_HPS):
            self.air.temp_c += m.hps_deg_c_per_minute * dt
        if self.energised(ROLE_MH):
            self.air.temp_c += m.mh_deg_c_per_minute * dt
        if fan:
            self.air.temp_c += (outdoor_c - self.air.temp_c) * m.fan_temp_pull_per_minute * dt

        # --- moisture ---------------------------------------------------
        # Plants transpire, the fan exhausts it. Tracked as vapour pressure so
        # RH falls out of temperature rather than being asserted.
        self.air.vapour_hpa += 0.02 * dt
        if fan:
            self.air.vapour_hpa -= (self.air.vapour_hpa - 8.0) * 0.15 * dt
        ceiling = saturation_pressure(self.air.temp_c)
        self.air.vapour_hpa = max(1.0, min(ceiling, self.air.vapour_hpa))

    # --------------------------------------------------------------- outputs

    def read(self, position: str) -> SiteReading:
        site = self.model.sites[position]
        temp_c = self.air.temp_c + site.temp_offset_c
        # The CO2 gradient scales with ENRICHMENT, not as a flat offset. A
        # constant +-72 ppm is only valid near the operating point it was
        # measured at (~1110 ppm bulk); applied at rest it drove the canopy to
        # 348 ppm - below outdoor air, which cannot happen with nothing running.
        enrichment = max(0.0, self.air.co2_ppm - self.model.outdoor_co2_ppm)
        co2 = self.model.outdoor_co2_ppm + enrichment * (1.0 + site.co2_gradient_fraction)
        rh = 100.0 * self.air.vapour_hpa / saturation_pressure(temp_c)
        return SiteReading(
            co2_ppm=round(co2, 1),
            temperature_c=round(temp_c, 2),
            humidity_pct=round(max(0.0, min(100.0, rh)), 2),
        )
