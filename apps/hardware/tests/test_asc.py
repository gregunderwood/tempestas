"""ASC is set at every startup and read back, like the temperature offset.

It has to be verified rather than assumed: a sensor drifting under ASC looks
exactly like a greenhouse getting leaner, so nothing in the data can catch it.
"""

from __future__ import annotations

from tempestas_agent.sensor import _GET_ASC, _SET_ASC, _START_PERIODIC, Scd4xSensor


class FakeBus:
    """Records what was written; answers reads from a script."""

    def __init__(self, asc_readback: int = 0):
        self.writes: list[tuple[int, list[int]]] = []
        self.asc_readback = asc_readback
        self.last_cmd: int | None = None

    def write_i2c_block_data(self, addr, reg, data):
        self.last_cmd = (reg << 8) | data[0] if data else reg
        self.writes.append((self.last_cmd, list(data)))

    def i2c_rdwr(self, *msgs):
        return None


def build(asc: bool, monkeypatch) -> tuple[Scd4xSensor, list[int]]:
    sent: list[tuple[int, int | None]] = []
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None, asc_enabled=asc)

    def fake_send(cmd, arg=None, exec_ms=1, tolerate=False):
        sent.append((cmd, arg))

    def fake_read_words(cmd, nwords, exec_ms=1):
        if cmd == _GET_ASC:
            return [1 if asc else 0]
        return [0] * nwords

    monkeypatch.setattr(sensor, "_send", fake_send)
    monkeypatch.setattr(sensor, "_read_words", fake_read_words)
    monkeypatch.setattr("smbus2.SMBus", lambda n: FakeBus())
    sensor.start()
    return sensor, sent


def test_asc_is_disabled_by_default(monkeypatch) -> None:
    sensor, sent = build(False, monkeypatch)
    assert (_SET_ASC, 0) in sent
    assert sensor.applied_asc is False


def test_asc_can_be_turned_on_for_a_node_in_unenriched_air(monkeypatch) -> None:
    sensor, sent = build(True, monkeypatch)
    assert (_SET_ASC, 1) in sent
    assert sensor.applied_asc is True


def test_asc_is_set_before_periodic_measurement_starts(monkeypatch) -> None:
    # The chip rejects every configuration command while measuring, so an ASC
    # write after START_PERIODIC would be silently ignored.
    _, sent = build(False, monkeypatch)
    cmds = [c for c, _ in sent]
    assert cmds.index(_SET_ASC) < cmds.index(_START_PERIODIC)


def test_the_applied_value_appears_in_the_startup_line(monkeypatch) -> None:
    sensor, _ = build(False, monkeypatch)
    assert "asc=off" in sensor.describe()

    sensor2, _ = build(True, monkeypatch)
    assert "asc=ON" in sensor2.describe()


def test_describe_says_unknown_before_start() -> None:
    # Never claim ASC is off when the chip has not been asked.
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None)
    assert "asc=?" in sensor.describe()
