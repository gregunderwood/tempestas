"""A thin HTTP shell over the world. Standard library only.

Why a service rather than a library each agent imports: the agents are separate
processes, and the whole reason the sandbox exists is to prove that two boxes
sharing one greenhouse behave correctly. Two processes with private copies of
the air would agree with each other perfectly and tell us nothing.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from .clock import SimClock
from .world import World

LOCAL_TZ = ZoneInfo("America/Vancouver")


class Simulation:
    """World plus clock, advanced lazily and under one lock."""

    def __init__(self, world: World, clock: SimClock) -> None:
        self.world = world
        self.clock = clock
        self._lock = threading.Lock()
        self._last: datetime = clock.now()

    def _advance_locked(self) -> None:
        now = self.clock.now()
        minutes = (now - self._last).total_seconds() / 60.0
        if minutes <= 0:
            return
        # Cap a single advance. A laptop that slept for six hours should not
        # integrate six hours in one call and call the result physics.
        minutes = min(minutes, 240.0)
        self.world.step(minutes, self.clock.minute_of_day(LOCAL_TZ))
        self._last = now

    def read(self, position: str) -> dict:
        with self._lock:
            self._advance_locked()
            r = self.world.read(position)
            return {
                "position": position,
                "co2_ppm": r.co2_ppm,
                "temperature_c": r.temperature_c,
                "humidity_pct": r.humidity_pct,
                "sim_time": self.clock.now().isoformat(),
            }

    def set_level(self, node_id: str, pin: int, level: int) -> dict:
        with self._lock:
            self._advance_locked()
            self.world.set_level(node_id, pin, level)
            return {"node_id": node_id, "pin": pin, "level": level}

    def snapshot(self) -> dict:
        with self._lock:
            self._advance_locked()
            w = self.world
            return {
                "sim_time": self.clock.now().isoformat(),
                "sim_time_local": self.clock.now().astimezone(LOCAL_TZ).isoformat(),
                "speed": self.clock.speed,
                "air": {
                    "co2_ppm": round(w.air.co2_ppm, 1),
                    "temp_c": round(w.air.temp_c, 2),
                    "vapour_hpa": round(w.air.vapour_hpa, 2),
                },
                "outdoor_c": round(w.outdoor_temp_c(self.clock.minute_of_day(LOCAL_TZ)), 2),
                "in_flight_ppm": round(w._in_flight_ppm, 1),
                "lines": [
                    {
                        "node_id": f.node_id,
                        "pin": f.pin,
                        "role": f.role,
                        "on_level": f.on_level,
                        "level": w.levels[key],
                        "energised": w.levels[key] is not None and w.levels[key] == f.on_level,
                    }
                    for key, f in sorted(w.fixtures.items())
                ],
                "sites": {p: self.world.read(p).__dict__ for p in w.model.sites},
            }


def make_handler(sim: Simulation):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args) -> None:  # noqa: D102 - quiet by default
            return

        def _send(self, code: int, body: dict) -> None:
            raw = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            try:
                if url.path == "/health":
                    return self._send(200, {"ok": True})
                if url.path == "/world":
                    return self._send(200, sim.snapshot())
                if url.path == "/sensor":
                    q = parse_qs(url.query)
                    position = (q.get("position") or [""])[0]
                    if position not in sim.world.model.sites:
                        return self._send(404, {"error": f"no site {position!r}"})
                    return self._send(200, sim.read(position))
                return self._send(404, {"error": "not found"})
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"error": str(exc)})

        def do_POST(self) -> None:  # noqa: N802
            url = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._send(400, {"error": "body must be JSON"})
            try:
                if url.path == "/relay":
                    return self._send(
                        200,
                        sim.set_level(
                            str(payload["node_id"]), int(payload["pin"]), int(payload["level"])
                        ),
                    )
                if url.path == "/clock":
                    if "speed" in payload:
                        sim.clock.set_speed(float(payload["speed"]))
                    if "jump_minutes" in payload:
                        sim.clock.jump(float(payload["jump_minutes"]))
                    return self._send(
                        200, {"sim_time": sim.clock.now().isoformat(), "speed": sim.clock.speed}
                    )
                return self._send(404, {"error": "not found"})
            except KeyError as exc:
                return self._send(400, {"error": f"missing field {exc}"})
            except (ValueError, TypeError) as exc:
                return self._send(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                return self._send(500, {"error": str(exc)})

    return Handler


def serve(sim: Simulation, host: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(sim))
    return server
