"""Stand-ins for the Pico's hardware, clock and broker, so the device code runs under CPython."""

from relay_lines import GPIO_OUT_REGISTER, GPIO_OUTPUT_ENABLE_REGISTER

SET_CLOCK_EPOCH_SECONDS = 1795215600.0


class FakeClock:
    def __init__(self, epoch_seconds=SET_CLOCK_EPOCH_SECONDS):
        self.now_milliseconds = 0
        self.epoch = epoch_seconds

    def ticks(self):
        return self.now_milliseconds

    def elapsed_since(self, earlier_ticks):
        return self.now_milliseconds - earlier_ticks

    def epoch_seconds(self):
        return self.epoch + self.now_milliseconds / 1000

    def advance_seconds(self, seconds):
        self.now_milliseconds += int(seconds * 1000)


class PublishedMessage:
    def __init__(self, topic, payload, is_retained, quality_of_service):
        self.topic = topic
        self.payload = payload
        self.is_retained = is_retained
        self.quality_of_service = quality_of_service


class FakePublisher:
    def __init__(self):
        self.messages = []

    def publish(self, topic, text, is_retained, quality_of_service):
        import json

        self.messages.append(PublishedMessage(topic, json.loads(text), is_retained, quality_of_service))

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
        if address == GPIO_OUTPUT_ENABLE_REGISTER:
            return self.chip.mask_of(lambda number: self.chip.modes[number] == FakePin.OUT)
        if address == GPIO_OUT_REGISTER:
            return self.chip.mask_of(lambda number: self.chip.output_levels[number] == 1)
        raise KeyError(hex(address))


class FakeMachine:
    """Pins that remember their mode and level, read back through the SIO registers as on the RP2040."""

    def __init__(self):
        self.modes = {}
        self.output_levels = {}
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

    def scan(self):
        return list(self.temperatures_by_rom)

    def convert_temp(self):
        self.conversions += 1

    def read_temp(self, rom):
        temperature = self.temperatures_by_rom[rom]
        if isinstance(temperature, Exception):
            raise temperature
        return temperature


class RecordingLog:
    def __init__(self):
        self.lines = []

    def __call__(self, message):
        self.lines.append(message)
