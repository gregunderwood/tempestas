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
    for untrue_reading in [85.0, -127.0, 99.0, None, OSError("CRC error")]:
        probes, _, _ = build_probes({AIR_ROM: untrue_reading})
        assert temperatures_of(probes) == []


def test_says_when_a_named_probe_is_missing_and_ignores_an_unnamed_one():
    probes, log, _ = build_probes({STRAY_ROM: 20.0})
    assert temperatures_of(probes) == []
    assert any("air" in line and "not on the bus" in line for line in log.lines)
    assert any("not configured" in line for line in log.lines)
