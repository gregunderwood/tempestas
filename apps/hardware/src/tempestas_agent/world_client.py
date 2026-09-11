"""Talk to the shared greenhouse simulator.

Standard library only, on purpose: the agent has to install on a 32-bit Pi
without building a wheel, and the sandbox is not worth a dependency.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request


class WorldUnreachable(RuntimeError):
    """The simulator is not answering. Never swallowed silently."""


class WorldClient:
    def __init__(self, base_url: str, timeout: float = 2.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise WorldUnreachable(f"{method} {path} -> {exc.code} {detail}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise WorldUnreachable(f"{method} {path} -> {exc}") from exc

    def read_site(self, position: str) -> dict:
        return self._request("GET", f"/sensor?position={position}")

    def set_level(self, node_id: str, pin: int, level: int) -> None:
        self._request("POST", "/relay", {"node_id": node_id, "pin": pin, "level": level})
