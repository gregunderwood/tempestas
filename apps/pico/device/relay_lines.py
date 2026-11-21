"""Never driven high: 3.3 V into the board's 5 V optocouplers is not reliably off, released is."""

SIO_BASE = 0xD0000000
GPIO_OUT_REGISTER = SIO_BASE + 0x010
GPIO_OUTPUT_ENABLE_REGISTER = SIO_BASE + 0x020

RELEASED_LEVEL = 1
DRIVEN_LOW_LEVEL = 0
VALID_LEVELS = (RELEASED_LEVEL, DRIVEN_LOW_LEVEL)


class UnmanagedPin(ValueError):
    pass


class ReleasedWhenHighLines:
    def __init__(self, machine, lines, failsafe_levels):
        self.machine = machine
        self.lines = tuple(lines)
        self.failsafe_levels = dict(failsafe_levels)

    def claim_at_failsafe(self):
        self.failsafe()

    def write(self, pin, level):
        if pin not in self.lines:
            raise UnmanagedPin("pin %d is not managed by this agent" % pin)
        if level not in VALID_LEVELS:
            raise ValueError("level must be 0 or 1, not %r" % (level,))
        if level == DRIVEN_LOW_LEVEL:
            self.machine.Pin(pin, self.machine.Pin.OUT, value=0)
        else:
            self.machine.Pin(pin, self.machine.Pin.IN, None)

    def level(self, pin):
        """Read from the chip's registers, not from what was last asked for."""
        pin_mask = 1 << pin
        is_driven = self.machine.mem32[GPIO_OUTPUT_ENABLE_REGISTER] & pin_mask
        if not is_driven:
            return RELEASED_LEVEL
        is_driven_high = self.machine.mem32[GPIO_OUT_REGISTER] & pin_mask
        return 1 if is_driven_high else DRIVEN_LOW_LEVEL

    def failsafe(self):
        for pin in self.lines:
            self.write(pin, self.failsafe_levels[pin])
