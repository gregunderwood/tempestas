import binascii

from ds18b20_probes import CONVERSION_MILLISECONDS, Ds18b20Probes, format_rom_as_linux_id
from fakes import FakeBusSensors, RecordingLog

AIR_ROM = binascii.unhexlify("28e86e43d4e13c66")
AIR_LINUX_ID = "28-3ce1d4436ee8"
STRAY_ROM = binascii.unhexlify("28aabbccddeeff01")


def build_probes(temperatures_by_rom, named_probes=None):
    log = RecordingLog()
    pauses = []
    probes = Ds18b20Probes(
        FakeBusSensors(temperatures_by_rom),
        named_probes if named_probes is not None else {AIR_LINUX_ID: "air"},
        pauses.append,
        log,
    )
    probes.start()
    return probes, log, pauses


def temperatures_of(probes):
    return [(reading.sensor_id, reading.temperature_celsius) for reading in probes.read_all()]


def test_names_a_rom_the_way_a_pi_kernel_does():
    assert format_rom_as_linux_id(AIR_ROM) == AIR_LINUX_ID


def test_reads_each_named_probe_after_one_conversion():
    probes, _, pauses = build_probes({AIR_ROM: 21.4375})
    assert temperatures_of(probes) == [("air", 21.4375)]
    assert pauses == [CONVERSION_MILLISECONDS]


def test_leaves_out_a_reading_nobody_measured():
    for untrue_reading in [85.0, -127.0, 99.0, bytes(9), OSError("CRC error")]:
        probes, _, _ = build_probes({AIR_ROM: untrue_reading})
        assert temperatures_of(probes) == []


def test_says_when_a_named_probe_is_missing_and_ignores_an_unnamed_one():
    probes, log, _ = build_probes({STRAY_ROM: 20.0})
    assert temperatures_of(probes) == []
    assert any("air" in line and "not on the bus" in line for line in log.lines)
    assert any("not configured" in line for line in log.lines)


class OneWireError(Exception):
    pass


def test_a_bus_that_stops_answering_leaves_the_reading_out_instead_of_crashing():
    probes, log, _ = build_probes({AIR_ROM: 21.0})
    probes.bus_sensors.bus_failure = OneWireError()
    assert temperatures_of(probes) == []
    assert "conversion failed" in log.lines[-1]
    probes.bus_sensors.bus_failure = None
    assert temperatures_of(probes) == [("air", 21.0)]


def test_a_probe_missing_at_boot_is_read_once_it_is_plugged_in():
    probes, _, _ = build_probes({})
    assert temperatures_of(probes) == []
    probes.bus_sensors.temperatures_by_rom[AIR_ROM] = 4.5
    assert temperatures_of(probes) == [("air", 4.5)]


def test_a_failed_scan_at_boot_is_logged_not_raised():
    bus_sensors = FakeBusSensors({AIR_ROM: 21.0})
    bus_sensors.bus_failure = OneWireError()
    log = RecordingLog()
    probes = Ds18b20Probes(bus_sensors, {AIR_LINUX_ID: "air"}, lambda milliseconds: None, log)
    probes.start()
    assert any("scan failed" in line for line in log.lines)


def test_reads_below_freezing_from_the_twos_complement_scratchpad():
    probes, _, _ = build_probes({AIR_ROM: -10.125})
    assert temperatures_of(probes) == [("air", -10.125)]


def test_names_the_all_zero_scratchpad_of_a_shorted_line():
    probes, log, _ = build_probes({AIR_ROM: bytes(9)})
    assert temperatures_of(probes) == []
    assert "all-zero" in log.lines[-1]
