"""GPIO backends.

Stage B runs with `gpio.lines` empty, and that is enforced structurally rather
than by a flag: with no lines the agent builds `NoGpio`, advertises no `gpio`
capability, and never opens a chip. The server then refuses to create a device
on this node at all, so there is no path by which a pin here can be addressed.

The real backend is deliberately absent. Writing untested relay-driving code now
would produce something that *looks* ready before the boot-window hazard has
been measured, and that hazard is the gating item: BCM 9-27 default to pull-down
and four of the five relays are active-LOW, so an unclaimed line commands its
relay ON. See docs/Safety.md and Stage C in docs/Roadmap.md.
"""

from __future__ import annotations

from typing import Protocol


class GpioUnavailable(RuntimeError):
    """This agent has no GPIO. Raised rather than silently doing nothing."""


class GpioBackend(Protocol):
    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None: ...
    def write(self, pin: int, level: int) -> None: ...
    def level(self, pin: int) -> int | None:
        """The last known level, or None for unknown. Unknown is NOT off."""
        ...

    def failsafe(self) -> None:
        """Drive every managed line to its configured safe level."""
        ...

    def close(self) -> None: ...


class NoGpio:
    """A node with no relays. Every write is a programming error, not a no-op."""

    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None:
        if lines:
            raise GpioUnavailable(f"NoGpio cannot claim lines {lines}")

    def write(self, pin: int, level: int) -> None:
        raise GpioUnavailable(
            f"this agent has no GPIO configured; refusing to drive pin {pin} to {level}"
        )

    def level(self, pin: int) -> int | None:
        return None

    def failsafe(self) -> None:
        return None

    def close(self) -> None:
        return None

    def describe(self) -> str:
        return "no gpio (sensor-only node)"


class SimulatedGpio:
    """In-memory lines, for sim mode and tests."""

    def __init__(self) -> None:
        self._levels: dict[int, int | None] = {}
        self._failsafe: dict[int, int] = {}
        self.closed = False

    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None:
        self._failsafe = dict(failsafe)
        # Claimed but never written is UNKNOWN, not off. Pretending to know is
        # exactly the lie the readback rules exist to prevent.
        self._levels = {pin: None for pin in lines}

    def write(self, pin: int, level: int) -> None:
        if pin not in self._levels:
            raise GpioUnavailable(f"pin {pin} is not managed by this agent")
        if level not in (0, 1):
            raise ValueError(f"level must be 0 or 1, not {level!r}")
        self._levels[pin] = level

    def level(self, pin: int) -> int | None:
        return self._levels.get(pin)

    def failsafe(self) -> None:
        for pin, level in self._failsafe.items():
            self._levels[pin] = level

    def close(self) -> None:
        # Deliberately does NOT release the lines. On real hardware freeing a
        # line lets it float back to its pull-down, which energises an
        # active-LOW relay - so shutdown drives the failsafe and holds it.
        self.closed = True

    def describe(self) -> str:
        return f"simulated gpio ({len(self._levels)} lines)"


def build(lines: tuple[int, ...], chip_label: str, simulated: bool):
    """Pick a backend. No lines means no GPIO, whatever else is configured."""
    if not lines:
        return NoGpio()
    if simulated:
        return SimulatedGpio()
    raise NotImplementedError(
        "The real lgpio backend is Stage C and is deliberately not written yet. "
        "It is gated on measuring the relay board's input pull-ups and adding the "
        "gpio= defaults to /boot/firmware/config.txt - until then an unclaimed "
        "active-LOW line commands its relay ON through every boot and crash gap. "
        "See docs/Safety.md#the-boot-window-hazard."
    )
