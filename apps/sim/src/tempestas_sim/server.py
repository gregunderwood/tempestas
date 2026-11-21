"""A standard-library HTTP shell over the world, so separate agent processes share one air."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import ParseResult, parse_qs, urlparse
from zoneinfo import ZoneInfo

from .clock import SimClock
from .world import World

LOCAL_TZ = ZoneInfo("America/Vancouver")

# A laptop that slept for hours should not integrate them all in one call.
MAX_ADVANCE_MINUTES = 240.0

NOT_FOUND = {"error": "not found"}


class Simulation:
    """World plus clock, advanced lazily and under one lock."""

    def __init__(self, world: World, clock: SimClock) -> None:
        self.world = world
        self.clock = clock
        self._lock = threading.Lock()
        self._last_advanced_at: datetime = clock.now()

    def _advance_locked(self) -> None:
        now = self.clock.now()
        minutes = (now - self._last_advanced_at).total_seconds() / 60.0
        if minutes <= 0:
            return
        minutes = min(minutes, MAX_ADVANCE_MINUTES)
        self.world.step(minutes, self.clock.minute_of_day(LOCAL_TZ))
        self._last_advanced_at = now

    def read_site(self, position: str) -> dict:
        with self._lock:
            self._advance_locked()
            reading = self.world.read(position)
            return {
                "position": position,
                "co2_ppm": reading.co2_ppm,
                "temperature_c": reading.temperature_c,
                "humidity_pct": reading.humidity_pct,
                "sim_time": self.clock.now().isoformat(),
            }

    def set_level(self, node_id: str, pin: int, level: int) -> dict:
        with self._lock:
            self._advance_locked()
            self.world.set_level(node_id, pin, level)
            return {"node_id": node_id, "pin": pin, "level": level}

    def take_snapshot(self) -> dict:
        with self._lock:
            self._advance_locked()
            world = self.world
            return {
                "sim_time": self.clock.now().isoformat(),
                "sim_time_local": self.clock.now().astimezone(LOCAL_TZ).isoformat(),
                "speed": self.clock.speed,
                "air": {
                    "co2_ppm": round(world.air.co2_ppm, 1),
                    "temp_c": round(world.air.temp_c, 2),
                    "vapour_hpa": round(world.air.vapour_hpa, 2),
                },
                "outdoor_c": round(world.outdoor_temp_c(self.clock.minute_of_day(LOCAL_TZ)), 2),
                "in_flight_ppm": round(world.in_flight_ppm, 1),
                "lines": [
                    {
                        "node_id": fixture.node_id,
                        "pin": fixture.pin,
                        "role": fixture.role,
                        "on_level": fixture.on_level,
                        "level": world.levels[key],
                        "energised": world.levels[key] is not None
                        and world.levels[key] == fixture.on_level,
                    }
                    for key, fixture in sorted(world.fixtures.items())
                ],
                "sites": {
                    position: self.world.read(position).__dict__ for position in world.model.sites
                },
            }

    def describe_clock(self) -> dict:
        return {"sim_time": self.clock.now().isoformat(), "speed": self.clock.speed}


def build_request_handler(simulation: Simulation) -> type[BaseHTTPRequestHandler]:
    class SimulationRequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:
            return

        def _send(self, status: int, body: dict) -> None:
            encoded = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            routes: dict[str, Callable[[ParseResult], None]] = {
                "/health": self._get_health,
                "/world": self._get_world,
                "/sensor": self._get_sensor,
            }
            try:
                route = routes.get(url.path)
                if route is None:
                    return self._send(404, NOT_FOUND)
                return route(url)
            except Exception as error:  # noqa: BLE001
                return self._send(500, {"error": str(error)})

        def _get_health(self, _url: ParseResult) -> None:
            self._send(200, {"ok": True})

        def _get_world(self, _url: ParseResult) -> None:
            self._send(200, simulation.take_snapshot())

        def _get_sensor(self, url: ParseResult) -> None:
            query = parse_qs(url.query)
            position = (query.get("position") or [""])[0]
            if position not in simulation.world.model.sites:
                return self._send(404, {"error": f"no site {position!r}"})
            self._send(200, simulation.read_site(position))

        def do_POST(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._send(400, {"error": "body must be JSON"})
            routes: dict[str, Callable[[dict], None]] = {
                "/relay": self._post_relay,
                "/clock": self._post_clock,
            }
            try:
                route = routes.get(url.path)
                if route is None:
                    return self._send(404, NOT_FOUND)
                return route(payload)
            except KeyError as error:
                return self._send(400, {"error": f"missing field {error}"})
            except (ValueError, TypeError) as error:
                return self._send(400, {"error": str(error)})
            except Exception as error:  # noqa: BLE001
                return self._send(500, {"error": str(error)})

        def _post_relay(self, payload: dict) -> None:
            applied_level = simulation.set_level(
                str(payload["node_id"]), int(payload["pin"]), int(payload["level"])
            )
            self._send(200, applied_level)

        def _post_clock(self, payload: dict) -> None:
            if "speed" in payload:
                simulation.clock.set_speed(float(payload["speed"]))
            if "jump_minutes" in payload:
                simulation.clock.jump(float(payload["jump_minutes"]))
            self._send(200, simulation.describe_clock())

    return SimulationRequestHandler


def create_server(simulation: Simulation, host: str, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), build_request_handler(simulation))
