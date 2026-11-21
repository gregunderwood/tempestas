"""A failed probe is left out of the cycle, never guessed, so the server sees it go stale."""

import binascii

CONVERSION_MILLISECONDS = 750
POWER_ON_RESET_CELSIUS = 85.0
LOWEST_PLAUSIBLE_CELSIUS = -40.0
HIGHEST_PLAUSIBLE_CELSIUS = 60.0
ROM_FAMILY_CODE_INDEX = 0
ROM_SERIAL_BYTES = slice(1, 7)
SCRATCHPAD_LOW_BYTE_INDEX = 0
SCRATCHPAD_HIGH_BYTE_INDEX = 1
BITS_PER_BYTE = 8
SIGN_BIT = 0x8000
TWO_BYTE_RANGE = 0x10000
SIXTEENTHS_PER_DEGREE = 16


def format_rom_as_linux_id(rom):
    serial_most_significant_first = bytes(reversed(rom[ROM_SERIAL_BYTES]))
    return "%02x-%s" % (rom[ROM_FAMILY_CODE_INDEX], binascii.hexlify(serial_most_significant_first).decode())


class ProbeReading:
    def __init__(self, sensor_id, temperature_celsius):
        self.sensor_id = sensor_id
        self.temperature_celsius = temperature_celsius


class Ds18b20Probes:
    def __init__(self, bus_sensors, named_probes, sleep_milliseconds, log):
        self.bus_sensors = bus_sensors
        self.named_probes = dict(named_probes)
        self.sleep_milliseconds = sleep_milliseconds
        self.log = log
        self.roms_by_linux_id = {}

    def start(self):
        self.scan()
        self.log_named_probes_missing_from_the_bus()
        self.log_probes_nobody_named()

    def log_named_probes_missing_from_the_bus(self):
        for linux_id, sensor_id in self.named_probes.items():
            if linux_id not in self.roms_by_linux_id:
                self.log("probe %s (%s) is not on the bus" % (sensor_id, linux_id))

    def log_probes_nobody_named(self):
        for linux_id in self.roms_by_linux_id:
            if linux_id not in self.named_probes:
                self.log("probe %s is on the bus but not configured; ignoring it" % linux_id)

    def sensor_ids(self):
        return list(self.named_probes.values())

    def scan(self):
        try:
            found_roms = self.bus_sensors.scan()
        except Exception as error:
            self.log("1-Wire scan failed: %r" % error)
            return
        self.roms_by_linux_id = {format_rom_as_linux_id(rom): rom for rom in found_roms}

    def is_any_named_probe_missing(self):
        return any(linux_id not in self.roms_by_linux_id for linux_id in self.named_probes)

    def read_all(self):
        if self.is_any_named_probe_missing():
            self.scan()
        if not self.roms_by_linux_id:
            return []
        if not self.convert_all():
            return []
        readings = []
        for linux_id, sensor_id in self.named_probes.items():
            temperature = self.read_probe(linux_id)
            if temperature is not None:
                readings.append(ProbeReading(sensor_id, temperature))
        return readings

    def convert_all(self):
        try:
            self.bus_sensors.convert_temp()
        except Exception as error:
            self.log("1-Wire conversion failed: %r" % error)
            return False
        self.sleep_milliseconds(CONVERSION_MILLISECONDS)
        return True

    def read_probe(self, linux_id):
        rom = self.roms_by_linux_id.get(linux_id)
        if rom is None:
            return None
        try:
            scratchpad = self.bus_sensors.read_scratch(rom)
        except Exception as error:
            self.log("probe %s read failed: %s" % (linux_id, error))
            return None
        if is_all_zero(scratchpad):
            # Zeros pass the CRC (the CRC of zeros is zero) and decode as exactly 0 °C: a shorted line.
            self.log("probe %s returned an all-zero scratchpad" % linux_id)
            return None
        temperature = decode_celsius(scratchpad)
        return temperature if is_plausible(temperature) else None


def is_all_zero(scratchpad):
    return all(byte == 0 for byte in scratchpad)


def decode_celsius(scratchpad):
    sixteenths = (
        scratchpad[SCRATCHPAD_HIGH_BYTE_INDEX] << BITS_PER_BYTE | scratchpad[SCRATCHPAD_LOW_BYTE_INDEX]
    )
    if sixteenths & SIGN_BIT:
        sixteenths -= TWO_BYTE_RANGE
    return sixteenths / SIXTEENTHS_PER_DEGREE


def is_plausible(temperature):
    if temperature == POWER_ON_RESET_CELSIUS:
        return False
    return LOWEST_PLAUSIBLE_CELSIUS <= temperature <= HIGHEST_PLAUSIBLE_CELSIUS
