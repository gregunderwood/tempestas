"""Sim time, so a seven-minute burn cycle can be watched in seven seconds.

Kept separate from the world because the world must stay pure: it is told how
many minutes elapsed, it never asks.

Speed matters for more than impatience. The rules engine branches on local wall
time - day and night segments, DST boundaries - and those paths are unreachable
in a test that runs at 1x. A DST bug has already shipped once here.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone


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
        """Re-anchor first, so changing speed never rewinds or jumps sim time."""
        if speed <= 0:
            raise ValueError("speed must be positive")
        self._start = self.now()
        self._anchor = self._monotonic()
        self._speed = speed

    def jump(self, minutes: float) -> None:
        self._start = self.now() + timedelta(minutes=minutes)
        self._anchor = self._monotonic()

    def now(self) -> datetime:
        elapsed = (self._monotonic() - self._anchor) * self._speed
        return self._start + timedelta(seconds=elapsed)

    def minute_of_day(self, tz: timezone | None = None) -> float:
        local = self.now().astimezone(tz) if tz else self.now()
        return local.hour * 60 + local.minute + local.second / 60.0
