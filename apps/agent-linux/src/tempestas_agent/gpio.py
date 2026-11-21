"""GPIO backends; see "The GPIO backend" in docs/Infrastructure/Linux Agent.md."""

from __future__ import annotations

import fcntl
import glob
import logging
import os
import struct
from typing import Protocol

from .world_client import WorldUnreachable

log = logging.getLogger("tempestas.agent")

VALID_LEVELS = (0, 1)

# struct gpiochip_info { char name[32]; char label[32]; __u32 lines; }, stable since 4.8.
_GPIO_GET_CHIPINFO_IOCTL = 0x8044B401
_CHIPINFO = struct.Struct("32s32sI")
_GPIOCHIP_PREFIX = "/dev/gpiochip"

# Held by another userspace consumer; kernel drivers such as I2C on BCM 2 and 3 still read 0.
_LINE_IN_USE = 1
_LGPIO_OK = 0


class GpioUnavailable(RuntimeError):
    """This agent has no GPIO. Raised rather than silently doing nothing."""


class GpioBusy(GpioUnavailable):
    """A managed line is held by somebody else. Two writers is the worst case."""


class GpioBackend(Protocol):
    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None: ...
    def write(self, pin: int, level: int) -> None: ...
    def level(self, pin: int) -> int | None:
        """The last known level, or None for unknown. Unknown is NOT off."""
        ...

    def failsafe(self) -> None: ...
    def close(self) -> None: ...


def refuse_invalid_write(pin: int, level: int, managed_pins) -> None:
    if pin not in managed_pins:
        raise GpioUnavailable(f"pin {pin} is not managed by this agent")
    if level not in VALID_LEVELS:
        raise ValueError(f"level must be 0 or 1, not {level!r}")


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

    @property
    def failsafe_levels(self) -> dict[int, int]:
        return self._failsafe

    @property
    def line_count(self) -> int:
        return len(self._levels)

    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None:
        self._failsafe = dict(failsafe)
        # Claimed but never written is UNKNOWN, not off.
        self._levels = {pin: None for pin in lines}

    def write(self, pin: int, level: int) -> None:
        refuse_invalid_write(pin, level, self._levels)
        self._levels[pin] = level

    def level(self, pin: int) -> int | None:
        return self._levels.get(pin)

    def failsafe(self) -> None:
        for pin, level in self._failsafe.items():
            self._levels[pin] = level

    def close(self) -> None:
        # Never releases: a freed line floats to its pull-down and energises an active-LOW relay.
        self.closed = True

    def describe(self) -> str:
        return f"simulated gpio ({self.line_count} lines)"


def decode_chipinfo(reply: bytes) -> tuple[str, str, int]:
    """Unpack a `gpiochip_info` reply into (name, label, line count)."""
    name, label, lines = _CHIPINFO.unpack(reply)
    return _decode_c_string(name), _decode_c_string(label), lines


def _decode_c_string(field: bytes) -> str:
    return field.split(b"\0", 1)[0].decode("ascii", "replace")


def read_chip_label(path: str) -> str:
    reply = bytearray(_CHIPINFO.size)
    with open(path, "rb") as chip:
        fcntl.ioctl(chip.fileno(), _GPIO_GET_CHIPINFO_IOCTL, reply)
    return decode_chipinfo(bytes(reply))[1]


def resolve_chip(label: str) -> int:
    # By label, never number: /dev/gpiochip4 is a symlink on a Pi 4 and a real chip on a Pi 5.
    found: dict[str, int] = {}
    for path in sorted(glob.glob(f"{_GPIOCHIP_PREFIX}*")):
        if os.path.islink(path):
            continue
        try:
            found[read_chip_label(path)] = int(path.removeprefix(_GPIOCHIP_PREFIX))
        except (OSError, ValueError) as error:
            log.warning("could not read chip info from %s: %s", path, error)
    if label not in found:
        raise GpioUnavailable(
            f"no gpiochip is labelled {label!r}; found {sorted(found) or 'none'}. "
            f"gpio.chip_label must match `gpiodetect` on this box."
        )
    return found[label]


class LgpioBackend:
    """The real backend: one chardev handle, claimed once, never released."""

    def __init__(self, chip_label: str, *, lgpio=None, resolve=resolve_chip):
        self._chip_label = chip_label
        self._lgpio = lgpio
        self._resolve = resolve
        self._handle: int | None = None
        self._chip: int | None = None
        self._managed: tuple[int, ...] = ()
        self._failsafe: dict[int, int] = {}

    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None:
        if self._handle is not None:
            # Measured: a second claim on a held line reports success and leaves the level alone.
            raise GpioUnavailable("lines are already claimed; this backend claims exactly once")
        missing = sorted(set(lines) - set(failsafe))
        if missing:
            raise GpioUnavailable(f"no failsafe level declared for lines {missing}")

        self._open_chip()
        self._failsafe = dict(failsafe)
        claimed: list[int] = []
        for pin in lines:
            self._claim_at_failsafe(pin, failsafe[pin], claimed)
            claimed.append(pin)
            self._verify_claimed_level(pin, failsafe[pin])
        self._managed = tuple(lines)
        log.info("claimed %s on %s at their failsafe levels", list(self._managed), self.describe())

    def write(self, pin: int, level: int) -> None:
        refuse_invalid_write(pin, level, self._managed)
        self._lgpio.gpio_write(self._handle, pin, level)

    def level(self, pin: int) -> int | None:
        """Read the pad. Never a cached value, and never a guess on error."""
        if self._handle is None:
            return None
        try:
            value = self._lgpio.gpio_read(self._handle, pin)
        except Exception as error:  # noqa: BLE001 - unknown is a valid answer here
            log.error("could not read back BCM %s: %s", pin, error)
            return None
        # lgpio reports failures as negative returns when exceptions are off.
        return value if value in VALID_LEVELS else None

    def failsafe(self) -> None:
        # Never raises: the dead-man publishes its alarm after this, and a raise would lose it.
        for pin, level in self._failsafe.items():
            try:
                self._lgpio.gpio_write(self._handle, pin, level)
            except Exception as error:  # noqa: BLE001 - logged per line, never swallowed
                log.error("FAILSAFE FAILED on BCM %s -> %s: %s", pin, level, error)

    def close(self) -> None:
        # No gpio_free or gpiochip_close: freeing is what hurt the old system, and gains nothing.
        self.failsafe()

    def describe(self) -> str:
        return f"lgpio {self._chip_label} ({_GPIOCHIP_PREFIX}{self._chip})"

    def _open_chip(self) -> None:
        if self._lgpio is None:
            import lgpio

            self._lgpio = lgpio
        self._chip = self._resolve(self._chip_label)
        self._handle = self._lgpio.gpiochip_open(self._chip)

    def _claim_at_failsafe(self, pin: int, level: int, claimed: list[int]) -> None:
        self._refuse_if_held(pin)
        try:
            self._lgpio.gpio_claim_output(self._handle, pin, level, self._bias_toward(level))
        except Exception as error:  # lgpio.error, whose type we do not import
            raise GpioBusy(
                f"could not claim BCM {pin} on {self._chip_label}: {error}. "
                f"Claimed so far and left at their safe level: {claimed or 'none'}"
            ) from error

    def _verify_claimed_level(self, pin: int, level: int) -> None:
        readback = self.level(pin)
        if readback != level:
            raise GpioUnavailable(
                f"BCM {pin} claimed at its safe level {level} but reads back {readback}"
            )

    def _bias_toward(self, level: int) -> int:
        return self._lgpio.SET_PULL_UP if level else self._lgpio.SET_PULL_DOWN

    def _refuse_if_held(self, pin: int) -> None:
        try:
            status, _offset, flags, name, user = self._lgpio.gpio_get_line_info(self._handle, pin)
        except Exception as error:  # noqa: BLE001 - advisory only; the claim enforces
            log.warning("could not read line info for BCM %s: %s", pin, error)
            return
        if status == _LGPIO_OK and flags & _LINE_IN_USE:
            raise GpioBusy(
                f"BCM {pin} ({name}) is already held by {user or 'another process'}. "
                f"Two writers on one relay line is the failure that produces impossible "
                f"states - refusing to start."
            )


class WorldGpio:
    """SimulatedGpio whose writes also drive the shared greenhouse simulator."""

    def __init__(self, node_id: str, client) -> None:
        self._node_id = node_id
        self._client = client
        self._local = SimulatedGpio()

    def claim(self, lines: tuple[int, ...], failsafe: dict[int, int]) -> None:
        self._local.claim(lines, failsafe)
        # Real hardware claims at the failsafe, so the world has to start there too.
        for pin, level in failsafe.items():
            self._push(pin, level)
            self._local.write(pin, level)

    def write(self, pin: int, level: int) -> None:
        self._local.write(pin, level)
        self._push(pin, level)

    def level(self, pin: int) -> int | None:
        return self._local.level(pin)

    def failsafe(self) -> None:
        self._local.failsafe()
        for pin, level in self._local.failsafe_levels.items():
            try:
                self._push(pin, level)
            except GpioUnavailable as error:
                # Never raises: this runs on dead-man expiry and on shutdown.
                log.error("failsafe could not reach the world for pin %s: %s", pin, error)

    def close(self) -> None:
        self.failsafe()
        self._local.close()

    @property
    def closed(self) -> bool:
        return self._local.closed

    def describe(self) -> str:
        return f"world gpio for {self._node_id} ({self._local.line_count} lines)"

    def _push(self, pin: int, level: int) -> None:
        try:
            self._client.set_level(self._node_id, pin, level)
        except WorldUnreachable as error:
            raise GpioUnavailable(
                f"world rejected {self._node_id}:{pin}={level}: {error}"
            ) from error


def build(lines: tuple[int, ...], chip_label: str, simulated: bool):
    """Pick a backend. No lines means no GPIO, whatever else is configured."""
    if not lines:
        return NoGpio()
    if simulated:
        return SimulatedGpio()
    return LgpioBackend(chip_label)
