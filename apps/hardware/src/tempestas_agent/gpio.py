"""GPIO backends.

A node with no `gpio.lines` gets `NoGpio` and never opens a chip; that is still
the posture for a sensor-only box, and it is structural rather than a flag.

`LgpioBackend` is the real one. Every non-obvious thing in it was measured on
elantris against the wired board rather than read out of a datasheet, and the
measurements are recorded next to the code that depends on them, because three
of them contradict what was assumed:

  * Claiming a line sets its direction and its level in one call, so there is no
    window where the pad is an output at the wrong level. Claim at the failsafe.
  * **A second claim on a line this handle already holds silently keeps the old
    level.** It returns success and changes nothing. So claim happens once.
  * **Releasing a line does not revert the pad.** `gpio_free`, and a `SIGKILL` of
    the whole process, both leave the pad an output still driving its last level
    with its bias intact - verified with `pinctrl get`. That cuts both ways: a
    process killed at the safe level holds the safe level, and one killed with a
    burner energised holds *that* until systemd restarts it and the claim below
    drives the failsafe. It is why claiming at the failsafe matters more than
    preserving state across a restart, and why the server re-asserts the full
    desired state on its heartbeat instead of sending one-shot toggles.

See docs/Safety.md and docs/Hardware.md.
"""

from __future__ import annotations

import fcntl
import glob
import logging
import os
import struct
from typing import Protocol

log = logging.getLogger("tempestas.agent")

# struct gpiochip_info { char name[32]; char label[32]; __u32 lines; } - the
# kernel's own chardev ABI, stable since 4.8, and what `gpiodetect` reads.
_GPIO_GET_CHIPINFO_IOCTL = 0x8044B401
_CHIPINFO = struct.Struct("32s32sI")

# Bit 0 of a line's flags means "held by another userspace consumer". It does
# NOT cover kernel drivers: BCM 2 and 3 are the I2C bus and still report 0 here.
# The claim itself is the enforcement; this check only buys a better message.
_LINE_IN_USE = 1


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


def decode_chipinfo(buf: bytes) -> tuple[str, str, int]:
    """Unpack a `gpiochip_info` reply into (name, label, line count)."""
    name, label, lines = _CHIPINFO.unpack(buf)
    return (
        name.split(b"\0", 1)[0].decode("ascii", "replace"),
        label.split(b"\0", 1)[0].decode("ascii", "replace"),
        lines,
    )


def read_chip_label(path: str) -> str:
    buf = bytearray(_CHIPINFO.size)
    with open(path, "rb") as chip:
        fcntl.ioctl(chip.fileno(), _GPIO_GET_CHIPINFO_IOCTL, buf)
    return decode_chipinfo(bytes(buf))[1]


def resolve_chip(label: str) -> int:
    """Find the chardev number whose chip carries `label`.

    By label, never by number, and never by the /dev/gpiochip4 alias: on a Pi 4
    that path is a symlink to gpiochip0 and on a Pi 5 it is a real chip. One
    build has to be right on both, and opening the wrong chip would not fail -
    it would drive line 5 of `raspberrypi-exp-gpio` and report success.
    """
    found: dict[str, int] = {}
    for path in sorted(glob.glob("/dev/gpiochip*")):
        if os.path.islink(path):
            continue
        try:
            found[read_chip_label(path)] = int(path.removeprefix("/dev/gpiochip"))
        except (OSError, ValueError) as err:
            log.warning("could not read chip info from %s: %s", path, err)
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
            # Measured: a second claim on a held line returns success and leaves
            # the level alone. Re-claiming to "reset" a pin would therefore be a
            # silent no-op on a relay, so it is refused outright.
            raise GpioUnavailable("lines are already claimed; this backend claims exactly once")
        missing = sorted(set(lines) - set(failsafe))
        if missing:
            # config.load already refuses this, but a line reaching the kernel
            # with nobody having decided its safe level is worth two checks.
            raise GpioUnavailable(f"no failsafe level declared for lines {missing}")

        if self._lgpio is None:
            import lgpio

            self._lgpio = lgpio
        self._chip = self._resolve(self._chip_label)
        self._handle = self._lgpio.gpiochip_open(self._chip)
        self._failsafe = dict(failsafe)

        claimed: list[int] = []
        for pin in lines:
            level = failsafe[pin]
            self._refuse_if_held(pin)
            try:
                # Direction, level and bias in one call: the pad is never an
                # output at a level nobody chose.
                self._lgpio.gpio_claim_output(self._handle, pin, level, self._bias(level))
            except Exception as err:  # lgpio.error, whose type we do not import
                raise GpioBusy(
                    f"could not claim BCM {pin} on {self._chip_label}: {err}. "
                    f"Claimed so far and left at their safe level: {claimed or 'none'}"
                ) from err
            claimed.append(pin)
            # Verify the pad before anything else in this process runs. A claim
            # that reports success but reads back wrong is a broken board, and
            # the startup path is the cheapest place to find that out.
            readback = self.level(pin)
            if readback != level:
                raise GpioUnavailable(
                    f"BCM {pin} claimed at its safe level {level} but reads back {readback}"
                )
        self._managed = tuple(lines)
        log.info("claimed %s on %s at their failsafe levels", list(self._managed), self.describe())

    def _bias(self, level: int) -> int:
        """Pull the pad toward the SAFE level, not toward any fixed direction.

        The internal pull is ~50 kOhm, far too weak to hold an opto-isolator
        input on its own - external pull-ups are mitigation 2 and this is
        mitigation 3. It earns its place because the bias survives both a
        release and a kill, so it is the state the pad settles into once no
        software is left to have an opinion.
        """
        return self._lgpio.SET_PULL_UP if level else self._lgpio.SET_PULL_DOWN

    def _refuse_if_held(self, pin: int) -> None:
        try:
            status, _offset, flags, name, user = self._lgpio.gpio_get_line_info(self._handle, pin)
        except Exception as err:  # noqa: BLE001 - advisory only; the claim enforces
            log.warning("could not read line info for BCM %s: %s", pin, err)
            return
        if status == 0 and flags & _LINE_IN_USE:
            raise GpioBusy(
                f"BCM {pin} ({name}) is already held by {user or 'another process'}. "
                f"Two writers on one relay line is the failure that produces impossible "
                f"states - refusing to start."
            )

    def write(self, pin: int, level: int) -> None:
        if pin not in self._managed:
            raise GpioUnavailable(f"pin {pin} is not managed by this agent")
        if level not in (0, 1):
            raise ValueError(f"level must be 0 or 1, not {level!r}")
        self._lgpio.gpio_write(self._handle, pin, level)

    def level(self, pin: int) -> int | None:
        """Read the pad. Never a cached value, and never a guess on error."""
        if self._handle is None:
            return None
        try:
            value = self._lgpio.gpio_read(self._handle, pin)
        except Exception as err:  # noqa: BLE001 - unknown is a valid answer here
            log.error("could not read back BCM %s: %s", pin, err)
            return None
        # lgpio reports failures as negative returns when exceptions are off.
        return value if value in (0, 1) else None

    def failsafe(self) -> None:
        """Drive every managed line to its safe level. Deliberately never raises.

        The dead-man calls this and then publishes its alarm; raising here would
        lose the alarm, which is the one message a human needs when this path
        runs. Every line is attempted even if an earlier one fails.
        """
        for pin, level in self._failsafe.items():
            try:
                self._lgpio.gpio_write(self._handle, pin, level)
            except Exception as err:  # noqa: BLE001 - logged per line, never swallowed
                log.error("FAILSAFE FAILED on BCM %s -> %s: %s", pin, level, err)

    def close(self) -> None:
        """Drive the safe level and stop. No `gpio_free`, no `gpiochip_close`.

        Freeing is the dangerous operation in the old system's shutdown path, and
        there is nothing to gain by it: the process is about to exit, and the pad
        holds whatever it was last driving either way.
        """
        self.failsafe()

    def describe(self) -> str:
        return f"lgpio {self._chip_label} (/dev/gpiochip{self._chip})"


def build(lines: tuple[int, ...], chip_label: str, simulated: bool):
    """Pick a backend. No lines means no GPIO, whatever else is configured."""
    if not lines:
        return NoGpio()
    if simulated:
        return SimulatedGpio()
    return LgpioBackend(chip_label)
