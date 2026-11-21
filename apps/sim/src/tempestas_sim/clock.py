"""Sim time, kept apart from the world so the world is told how long passed and never asks."""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

MINUTES_PER_HOUR = 60
SECONDS_PER_MINUTE = 60.0


class SimClock:
    def __init__(self, start: datetime, speed: float = 1.0, monotonic=time.monotonic) -> None:
        if start.tzinfo is None:
            raise ValueError("sim clock needs an aware datetime; naive time is how DST bugs start")
        self._start = start
        self._speed = speed
        self._monotonic = monotonic
        self._anchor = monotonic()

    @property
    def speed(self) -> float:
        return self._speed

    def set_speed(self, speed: float) -> None:
        if speed <= 0:
            raise ValueError("speed must be positive")
        self._reanchor(self.now())
        self._speed = speed

    def jump(self, minutes: float) -> None:
        self._reanchor(self.now() + timedelta(minutes=minutes))

    def _reanchor(self, start: datetime) -> None:
        self._start = start
        self._anchor = self._monotonic()

    def now(self) -> datetime:
        elapsed_seconds = (self._monotonic() - self._anchor) * self._speed
        return self._start + timedelta(seconds=elapsed_seconds)

    def minute_of_day(self, zone: timezone | None = None) -> float:
        local = self.now().astimezone(zone) if zone else self.now()
        return local.hour * MINUTES_PER_HOUR + local.minute + local.second / SECONDS_PER_MINUTE
