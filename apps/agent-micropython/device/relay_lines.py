"""Never driven high: 3.3 V into the board's 5 V optocouplers is not reliably off, released is."""

RELEASED_LEVEL = 1
DRIVEN_LOW_LEVEL = 0
DRIVEN_HIGH_LEVEL = 1
VALID_LEVELS = (RELEASED_LEVEL, DRIVEN_LOW_LEVEL)


class UnmanagedPin(ValueError):
    pass


class ReleasedWhenHighLines:
    def __init__(self, machine, board, lines, failsafe_levels):
        self.machine = machine
        self.board = board
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
            self.machine.Pin(pin, self.machine.Pin.OUT, value=DRIVEN_LOW_LEVEL)
        else:
            self.machine.Pin(pin, self.machine.Pin.IN, None)

    def read_level(self, pin):
        # From the chip's registers, not from what was last asked for, so a report is never stale.
        if not self.board.is_pin_driven(pin):
            return RELEASED_LEVEL
        return DRIVEN_HIGH_LEVEL if self.board.is_pin_driven_high(pin) else DRIVEN_LOW_LEVEL

    def failsafe(self):
        for pin in self.lines:
            self.write(pin, self.failsafe_levels[pin])
