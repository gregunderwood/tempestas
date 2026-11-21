"""DS18B20 probes on one 1-Wire bus, named by ROM in the same form a Pi's kernel uses.

Never invents a reading: a probe that fails is left out of the cycle, so the server sees it go
stale rather than seeing a number nobody measured.
"""

import binascii

CONVERSION_MILLISECONDS = 750
POWER_ON_RESET_CELSIUS = 85.0
LOWEST_PLAUSIBLE_CELSIUS = -40.0
HIGHEST_PLAUSIBLE_CELSIUS = 60.0
DS18B20_FAMILY_CODE = 0x28


def format_rom_as_linux_id(rom):
    """`28-3ce1d4436ee8`: family, then the six serial bytes most significant first."""
    serial_most_significant_first = bytes(reversed(rom[1:7]))
    return "%02x-%s" % (rom[0], binascii.hexlify(serial_most_significant_first).decode())


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
        for rom in self.bus_sensors.scan():
            self.roms_by_linux_id[format_rom_as_linux_id(rom)] = rom
        for linux_id, sensor_id in self.named_probes.items():
            if linux_id not in self.roms_by_linux_id:
                self.log("probe %s (%s) is not on the bus" % (sensor_id, linux_id))
        for linux_id in self.roms_by_linux_id:
            if linux_id not in self.named_probes:
                self.log("probe %s is on the bus but not configured; ignoring it" % linux_id)

    def sensor_ids(self):
        return list(self.named_probes.values())

    def read_all(self):
        if not self.roms_by_linux_id:
            return []
        self.bus_sensors.convert_temp()
        self.sleep_milliseconds(CONVERSION_MILLISECONDS)
        readings = []
        for linux_id, sensor_id in self.named_probes.items():
            temperature = self.read_probe(linux_id)
            if temperature is not None:
                readings.append(ProbeReading(sensor_id, temperature))
        return readings

    def read_probe(self, linux_id):
        rom = self.roms_by_linux_id.get(linux_id)
        if rom is None:
            return None
        try:
            temperature = self.bus_sensors.read_temp(rom)
        except Exception as error:
            self.log("probe %s read failed: %s" % (linux_id, error))
            return None
        return temperature if is_plausible(temperature) else None


def is_plausible(temperature):
    if temperature is None or temperature == POWER_ON_RESET_CELSIUS:
        return False
    return LOWEST_PLAUSIBLE_CELSIUS <= temperature <= HIGHEST_PLAUSIBLE_CELSIUS
