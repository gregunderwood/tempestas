"""DS18B20 probes, against a fake /sys/bus/w1/devices tree.

Each refusal here is a way the chip produces a plausible number that is not a
measurement. In a pumphouse "plausible" is the dangerous part: 0 °C and 85 °C
are both numbers a thermostat will act on.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from tempestas_agent.ds18b20 import NOT_MEASURED, Ds18b20Sensors, Probe, parse_w1_slave

PIPES = Probe("28-0000000000a1", "pipes")
AIR = Probe("28-0000000000b2", "air")


def w1(milli_c: int, crc: str = "YES", scratchpad: str = "72 01 4b 46 7f ff 0e 10 57") -> str:
    return f"{scratchpad} : crc=57 {crc}\n{scratchpad} t={milli_c}\n"


def bus(root: Path, **probes: str) -> Path:
    """Write one w1_slave per ROM. Keyword names are ROM ids with `_` for `-`."""
    for rom, text in probes.items():
        device = root / rom.replace("_", "-")
        device.mkdir(parents=True, exist_ok=True)
        (device / "w1_slave").write_text(text)
    return root


class Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class TestParse:
    def test_a_good_read(self):
        m = parse_w1_slave(w1(3125))
        assert (m.value, m.valid, m.unit) == (3.12, True, "C")

    def test_a_below_zero_read(self):
        assert parse_w1_slave(w1(-1500)).value == -1.5

    # A corrupted transfer: a long cable, a weak pull-up, a heater's switching
    # transient on the same run.
    def test_a_failed_crc_is_refused(self):
        m = parse_w1_slave(w1(3125, crc="NO"))
        assert not m.valid and m.reason == "CRC_FAILED"

    # The power-on reset value, returned with a valid CRC by a probe that
    # browned out between conversions.
    def test_the_power_on_reset_value_is_refused(self):
        m = parse_w1_slave(w1(85_000))
        assert not m.valid and m.reason.startswith("POWER_ON_RESET")

    # The CRC of all zeros is zero, so the kernel says YES and t=0. A shorted
    # data line reads exactly this, and 0 °C is a believable pumphouse.
    def test_an_all_zero_scratchpad_is_refused_despite_its_crc(self):
        zeros = "00 00 00 00 00 00 00 00 00"
        m = parse_w1_slave(w1(0, scratchpad=zeros))
        assert not m.valid and m.reason == "ALL_ZERO_SCRATCHPAD"

    def test_a_genuine_zero_degrees_is_accepted(self):
        # Zero from real scratchpad bytes is a measurement, not a short.
        m = parse_w1_slave(w1(0, scratchpad="00 00 4b 46 7f ff 00 10 e0"))
        assert m.valid and m.value == 0.0

    @pytest.mark.parametrize("milli", [-45_000, 61_000, 127_937])
    def test_out_of_range_is_refused(self, milli):
        assert not parse_w1_slave(w1(milli)).valid

    @pytest.mark.parametrize("text", ["", "72 01 : crc=57 YES\n", "a : crc=57 YES\nno temp here\n"])
    def test_a_truncated_read_is_refused(self, text):
        assert not parse_w1_slave(text).valid


class TestSensors:
    def test_each_probe_is_its_own_sensor(self, tmp_path):
        root = bus(tmp_path, **{"28_0000000000a1": w1(3125), "28_0000000000b2": w1(5500)})
        sensors = Ds18b20Sensors((PIPES, AIR), w1_root=root)

        readings = dict(sensors.read_all())

        assert set(readings) == {"pipes", "air"}
        assert readings["pipes"].temperature_c.value == 3.12
        assert readings["air"].temperature_c.value == 5.5

    # A probe never could measure CO2 or humidity, and says so rather than
    # dropping the key - which would be a contract change.
    def test_the_metrics_a_probe_lacks_are_reported_as_not_measured(self, tmp_path):
        root = bus(tmp_path, **{"28_0000000000a1": w1(3125)})
        [(_, reading)] = Ds18b20Sensors((PIPES,), w1_root=root).read_all()
        assert reading.co2_ppm.valid is False and reading.co2_ppm.reason == NOT_MEASURED
        assert reading.humidity_pct.valid is False and reading.humidity_pct.reason == NOT_MEASURED

    def test_it_declares_temperature_only(self, tmp_path):
        infos = Ds18b20Sensors((PIPES, AIR), w1_root=tmp_path).sensors()
        assert [(i.sensor_id, i.kind, i.metrics) for i in infos] == [
            ("pipes", "ds18b20", ("temperature",)),
            ("air", "ds18b20", ("temperature",)),
        ]

    # One dead probe must not take the others with it: the server takes the
    # coldest of whatever remains.
    def test_a_missing_probe_is_absent_and_the_rest_still_publish(self, tmp_path):
        root = bus(tmp_path, **{"28_0000000000b2": w1(5500)})
        readings = Ds18b20Sensors((PIPES, AIR), w1_root=root).read_all()
        assert [sensor_id for sensor_id, _ in readings] == ["air"]

    def test_a_refused_read_is_absent_not_published_as_invalid(self, tmp_path):
        root = bus(tmp_path, **{"28_0000000000a1": w1(85_000)})
        assert Ds18b20Sensors((PIPES,), w1_root=root).read_all() == []

    # A glitch to 30 °C between two 3 °C reads ten seconds apart is not the
    # pumphouse warming up.
    def test_an_impossible_jump_is_refused(self, tmp_path):
        clock = Clock()
        root = bus(tmp_path, **{"28_0000000000a1": w1(3000)})
        sensors = Ds18b20Sensors((PIPES,), w1_root=root, monotonic=clock)
        assert len(sensors.read_all()) == 1

        clock.t = 10.0
        bus(root, **{"28_0000000000a1": w1(30_000)})
        assert sensors.read_all() == []

    def test_a_dead_probe_logs_once_not_every_cycle(self, tmp_path, caplog):
        root = bus(tmp_path, **{"28_0000000000a1": w1(3125, crc="NO")})
        sensors = Ds18b20Sensors((PIPES,), w1_root=root)
        with caplog.at_level(logging.WARNING, logger="tempestas.agent.ds18b20"):
            for _ in range(5):
                sensors.read_all()
            bus(root, **{"28_0000000000a1": w1(3125)})
            sensors.read_all()

        messages = [r.getMessage() for r in caplog.records]
        assert len([m for m in messages if "refused:" in m]) == 1
        assert any("after 5 refused reads" in m for m in messages)

    def test_start_names_unconfigured_and_missing_probes(self, tmp_path, caplog):
        root = bus(tmp_path, **{"28_0000000000b2": w1(5500), "28_0000000000c3": w1(4000)})
        with caplog.at_level(logging.WARNING, logger="tempestas.agent.ds18b20"):
            Ds18b20Sensors((PIPES, AIR), w1_root=root).start()
        text = caplog.text
        assert "pipes (28-0000000000a1) is not on the bus" in text
        assert "28-0000000000c3 is on the bus but not configured" in text

    # Not fatal: the agent still owns the heater relays, and their failsafe
    # does not need a thermometer.
    def test_start_survives_a_missing_bus(self, tmp_path, caplog):
        sensors = Ds18b20Sensors((PIPES,), w1_root=tmp_path / "absent")
        with caplog.at_level(logging.ERROR, logger="tempestas.agent.ds18b20"):
            sensors.start()
        assert "w1-gpio" in caplog.text
        assert sensors.read_all() == []
