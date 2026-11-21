"""The greenhouse simulator client: stdlib only, so a 32-bit Pi installs it without a wheel."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

DEFAULT_TIMEOUT_S = 2.0
JSON_HEADERS = {"Content-Type": "application/json"}


class WorldUnreachable(RuntimeError):
    """The simulator is not answering. Never swallowed silently."""


class WorldClient:
    def __init__(self, base_url: str, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def read_site(self, position: str) -> dict:
        return self._request("GET", f"/sensor?position={position}")

    def set_level(self, node_id: str, pin: int, level: int) -> None:
        self._request("POST", "/relay", {"node_id": node_id, "pin": pin, "level": level})

    def _request(self, method: str, path: str, body: dict | None = None) -> dict:
        encoded_body = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=encoded_body,
            method=method,
            headers=JSON_HEADERS if encoded_body else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            detail = error.read().decode(errors="replace")
            raise WorldUnreachable(f"{method} {path} -> {error.code} {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise WorldUnreachable(f"{method} {path} -> {error}") from error
