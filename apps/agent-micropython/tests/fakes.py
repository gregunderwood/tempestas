"""Stand-ins for the Pico's hardware, clock and broker, so the device code runs under CPython."""

import importlib.util
import sys
import types
from pathlib import Path

BOARDS = Path(__file__).resolve().parents[1] / "device" / "boards"

SET_CLOCK_EPOCH_SECONDS = 1795215600


TICKS_PERIOD = 2**30
HALF_TICKS_PERIOD = TICKS_PERIOD // 2


def load_board(board_name, machine):
    """A fresh copy of a board module, reading this machine rather than a real one."""
    sys.modules.setdefault("machine", types.SimpleNamespace())
    spec = importlib.util.spec_from_file_location("board_" + board_name, BOARDS / (board_name + ".py"))
    board = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(board)
    board.machine = machine
    return board


PICO_W = load_board("pico_w", None)


class FakeClock:
    """Ticks wrap as MicroPython's ticks_ms and ticks_diff do, about every 12.4 days."""

    def __init__(self, epoch_seconds=SET_CLOCK_EPOCH_SECONDS):
        self.now_milliseconds = 0
        self.epoch = epoch_seconds

    def ticks(self):
        return self.now_milliseconds % TICKS_PERIOD

    def elapsed_since(self, earlier_ticks):
        return (self.ticks() - earlier_ticks + HALF_TICKS_PERIOD) % TICKS_PERIOD - HALF_TICKS_PERIOD

    def epoch_seconds(self):
        return self.epoch + self.now_milliseconds // 1000

    def advance_seconds(self, seconds):
        self.now_milliseconds += int(seconds * 1000)


class PublishedMessage:
    def __init__(self, topic, payload, is_retained, quality_of_service, should_hold_while_offline):
        self.topic = topic
        self.payload = payload
        self.is_retained = is_retained
        self.quality_of_service = quality_of_service
        self.should_hold_while_offline = should_hold_while_offline


class FakePublisher:
    def __init__(self):
        self.messages = []

    def publish(self, topic, text, is_retained, quality_of_service, should_hold_while_offline):
        import json

        self.messages.append(
            PublishedMessage(
                topic, json.loads(text), is_retained, quality_of_service, should_hold_while_offline
            )
        )

    def on_topic(self, suffix):
        return [message for message in self.messages if message.topic.endswith(suffix)]

    def topics(self):
        return [message.topic for message in self.messages]


class FakePin:
    IN = "in"
    OUT = "out"

    def __init__(self, chip, number, mode, pull=None, value=None):
        chip.modes[number] = mode
        chip.output_levels[number] = value if mode == FakePin.OUT else 0


class FakeRegisters:
    def __init__(self, chip):
        self.chip = chip

    def __getitem__(self, address):
        if address == PICO_W.GPIO_OUTPUT_ENABLE_REGISTER:
            return self.chip.mask_of(lambda number: self.chip.modes[number] == FakePin.OUT)
        if address == PICO_W.GPIO_OUT_REGISTER:
            return self.chip.mask_of(lambda number: self.chip.output_levels[number] == 1)
        if address == PICO_W.WATCHDOG_CONTROL_REGISTER:
            return PICO_W.WATCHDOG_ENABLE_BIT if self.chip.is_watchdog_armed else 0
        raise KeyError(hex(address))


class FakeMachine:
    """Pins that remember their mode and level, read back through the SIO registers as on the RP2040."""

    def __init__(self):
        self.modes = {}
        self.output_levels = {}
        self.is_watchdog_armed = False
        self.mem32 = FakeRegisters(self)
        chip = self

        class Pin(FakePin):
            def __init__(self, number, mode, pull=None, value=None):
                super().__init__(chip, number, mode, pull, value)

        self.Pin = Pin

    def mask_of(self, is_set):
        mask = 0
        for number in self.modes:
            if is_set(number):
                mask |= 1 << number
        return mask


class FakeBusSensors:
    def __init__(self, temperatures_by_rom):
        self.temperatures_by_rom = temperatures_by_rom
        self.conversions = 0
        self.bus_failure = None

    def scan(self):
        if self.bus_failure is not None:
            raise self.bus_failure
        return list(self.temperatures_by_rom)

    def convert_temp(self):
        if self.bus_failure is not None:
            raise self.bus_failure
        self.conversions += 1

    def read_scratch(self, rom):
        temperature = self.temperatures_by_rom[rom]
        if isinstance(temperature, Exception):
            raise temperature
        if isinstance(temperature, bytes):
            return temperature
        sixteenths = round(temperature * 16) & 0xFFFF
        return bytes((sixteenths & 0xFF, sixteenths >> 8, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10, 0x00))


class RecordingLog:
    def __init__(self):
        self.lines = []

    def __call__(self, message):
        self.lines.append(message)
