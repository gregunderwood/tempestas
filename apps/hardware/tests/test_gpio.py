"""The relay backend. Every fake here mimics a behaviour measured on elantris."""

from __future__ import annotations

import struct

import pytest

from tempestas_agent.gpio import (
    GpioBusy,
    GpioUnavailable,
    LgpioBackend,
    NoGpio,
    SimulatedGpio,
    build,
    decode_chipinfo,
)

# The board as wired: BCM 5 -> In6 (CO2), 6 -> In7, 4 -> In8. Active LOW, so 1
# is the de-energised level and therefore the failsafe for all three.
LINES = (5, 6, 4)
FAILSAFE = {5: 1, 6: 1, 4: 1}


class FakeLgpio:
    """A stand-in for the C module, faithful to what the real one was observed to do."""

    SET_PULL_UP = 32
    SET_PULL_DOWN = 64

    def __init__(self, held: dict[int, str] | None = None, open_fails: bool = False):
        self.levels: dict[int, int] = {}
        self.bias: dict[int, int] = {}
        self.held = held or {}
        self.open_fails = open_fails
        self.freed: list[int] = []
        self.chips_closed: list[int] = []
        self.write_errors: set[int] = set()
        self.read_errors: set[int] = set()

    def gpiochip_open(self, chip):
        if self.open_fails:
            raise OSError("no such chip")
        return 100 + chip

    def gpio_get_line_info(self, _handle, pin):
        in_use = 1 if pin in self.held else 0
        return [0, pin, in_use | 2, f"GPIO{pin}", self.held.get(pin, "")]

    def gpio_claim_output(self, _handle, pin, level=0, lFlags=0):  # noqa: N803 - the C signature
        if pin in self.held:
            raise RuntimeError("GPIO busy")
        # Measured: a second claim keeps the level the line already has.
        if pin not in self.levels:
            self.levels[pin] = level
        self.bias[pin] = lFlags
        return 0

    def gpio_write(self, _handle, pin, level):
        if pin in self.write_errors:
            raise RuntimeError(f"write failed on {pin}")
        self.levels[pin] = level

    def gpio_read(self, _handle, pin):
        if pin in self.read_errors:
            raise RuntimeError(f"read failed on {pin}")
        return self.levels[pin]

    def gpio_free(self, _handle, pin):
        self.freed.append(pin)

    def gpiochip_close(self, handle):
        self.chips_closed.append(handle)


def backend(fake: FakeLgpio | None = None, label: str = "pinctrl-bcm2711") -> LgpioBackend:
    return LgpioBackend(label, lgpio=fake or FakeLgpio(), resolve=lambda _label: 0)


# ------------------------------------------------------------------ chip lookup


def test_decode_chipinfo_reads_the_kernel_struct():
    buf = struct.pack("32s32sI", b"gpiochip0", b"pinctrl-bcm2711", 58)
    assert decode_chipinfo(buf) == ("gpiochip0", "pinctrl-bcm2711", 58)


def test_a_chip_label_that_is_not_present_names_what_was_found():
    with pytest.raises(GpioUnavailable, match="pinctrl-rp1"):
        LgpioBackend("pinctrl-rp1", lgpio=FakeLgpio(), resolve=_missing_chip("pinctrl-rp1")).claim(
            LINES, FAILSAFE
        )


def _missing_chip(label):
    def resolve(_label):
        raise GpioUnavailable(f"no gpiochip is labelled {label!r}; found ['pinctrl-bcm2711']")

    return resolve


# ------------------------------------------------------------------ claiming


def test_claim_leaves_every_line_at_its_failsafe_level():
    fake = FakeLgpio()
    backend(fake).claim(LINES, FAILSAFE)
    assert fake.levels == {5: 1, 6: 1, 4: 1}


# Mitigation 3 in docs/Safety.md, generalised: the bias pulls toward the SAFE
# level rather than toward a fixed direction, so an active-HIGH line on some
# future board gets a pull-down without anyone having to remember.
def test_the_bias_pulls_toward_the_safe_level_in_both_directions():
    fake = FakeLgpio()
    backend(fake).claim((5, 26), {5: 1, 26: 0})
    assert fake.bias == {5: FakeLgpio.SET_PULL_UP, 26: FakeLgpio.SET_PULL_DOWN}


def test_a_line_held_by_another_process_refuses_the_whole_startup():
    fake = FakeLgpio(held={6: "tempestas-agent"})
    with pytest.raises(GpioBusy, match="tempestas-agent"):
        backend(fake).claim(LINES, FAILSAFE)


# The advisory check only reads line info, which does not see kernel drivers.
# When it misses, the kernel's own refusal has to be what stops us.
def test_a_claim_the_kernel_refuses_still_stops_startup():
    fake = FakeLgpio()
    fake.gpio_get_line_info = lambda _h, pin: [0, pin, 2, f"GPIO{pin}", ""]
    fake.held = {6: "invisible"}
    with pytest.raises(GpioBusy, match="BCM 6"):
        backend(fake).claim(LINES, FAILSAFE)


def test_a_line_that_reads_back_wrong_refuses_startup():
    fake = FakeLgpio()
    fake.gpio_read = lambda _h, pin: 0  # claimed at 1, pad says 0
    with pytest.raises(GpioUnavailable, match="reads back 0"):
        backend(fake).claim(LINES, FAILSAFE)


def test_a_missing_failsafe_level_is_refused_here_too():
    with pytest.raises(GpioUnavailable, match=r"\[4\]"):
        backend().claim(LINES, {5: 1, 6: 1})


# Measured on hardware: re-claiming keeps the old level and reports success, so
# a second claim would look like a reset and be a no-op on a live relay.
def test_claiming_twice_is_refused_rather_than_silently_doing_nothing():
    hw = backend()
    hw.claim(LINES, FAILSAFE)
    with pytest.raises(GpioUnavailable, match="exactly once"):
        hw.claim(LINES, FAILSAFE)


# ------------------------------------------------------------------ driving


def test_write_and_readback_round_trip():
    fake = FakeLgpio()
    hw = backend(fake)
    hw.claim(LINES, FAILSAFE)
    hw.write(5, 0)
    assert hw.level(5) == 0
    assert fake.levels[5] == 0


def test_an_unmanaged_pin_is_refused():
    hw = backend()
    hw.claim(LINES, FAILSAFE)
    with pytest.raises(GpioUnavailable, match="not managed"):
        hw.write(21, 0)


def test_a_level_that_is_not_zero_or_one_is_refused():
    hw = backend()
    hw.claim(LINES, FAILSAFE)
    with pytest.raises(ValueError, match="must be 0 or 1"):
        hw.write(5, 2)


# Unknown is a real answer and the readback path must be able to give it. The
# alternative is reporting a burner relay as off because a read errored.
def test_a_failed_readback_reports_unknown_rather_than_a_level():
    fake = FakeLgpio()
    hw = backend(fake)
    hw.claim(LINES, FAILSAFE)
    fake.read_errors.add(5)
    assert hw.level(5) is None


def test_level_before_any_claim_is_unknown():
    assert backend().level(5) is None


# ------------------------------------------------------------------ failing safe


def test_failsafe_drives_every_line_to_its_declared_level():
    fake = FakeLgpio()
    hw = backend(fake)
    hw.claim(LINES, FAILSAFE)
    hw.write(5, 0)
    hw.write(6, 0)
    hw.failsafe()
    assert fake.levels == {5: 1, 6: 1, 4: 1}


# The dead-man drives the failsafe and THEN publishes its alarm. A raise here
# would lose the alarm, which is the one message a human needs at that moment.
def test_failsafe_keeps_going_and_does_not_raise_when_one_line_fails():
    fake = FakeLgpio()
    hw = backend(fake)
    hw.claim(LINES, FAILSAFE)
    hw.write(5, 0)
    hw.write(6, 0)
    fake.write_errors.add(5)
    hw.failsafe()
    assert fake.levels[6] == 1
    assert fake.levels[5] == 0  # the one that failed, honestly still energised


# Freeing the line is the operation that hurt the old system. Nothing in the
# shutdown path may reach for it.
def test_close_drives_the_failsafe_and_never_releases_the_lines():
    fake = FakeLgpio()
    hw = backend(fake)
    hw.claim(LINES, FAILSAFE)
    hw.write(5, 0)
    hw.close()
    assert fake.levels[5] == 1
    assert fake.freed == []
    assert fake.chips_closed == []


# ------------------------------------------------------------------ the seam


def test_no_lines_means_no_gpio_even_when_a_chip_is_configured():
    assert isinstance(build((), "pinctrl-bcm2711", simulated=False), NoGpio)


def test_simulated_wins_when_lines_are_configured():
    assert isinstance(build(LINES, "pinctrl-bcm2711", simulated=True), SimulatedGpio)


def test_real_hardware_now_gets_the_lgpio_backend():
    assert isinstance(build(LINES, "pinctrl-bcm2711", simulated=False), LgpioBackend)


def test_nogpio_raises_rather_than_quietly_doing_nothing():
    with pytest.raises(GpioUnavailable, match="refusing to drive"):
        NoGpio().write(5, 0)
