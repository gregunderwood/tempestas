"""ASC is set at every startup and read back, because nothing in the data can catch its drift."""

from __future__ import annotations

from tempestas_agent.sensor import _GET_ASC, _SET_ASC, _START_PERIODIC, Scd4xSensor


class FakeBus:
    def i2c_rdwr(self, *messages):
        return None


def build(is_asc_enabled: bool, monkeypatch) -> tuple[Scd4xSensor, list[tuple[int, int | None]]]:
    sent: list[tuple[int, int | None]] = []
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None, asc_enabled=is_asc_enabled)

    def fake_send(command, argument=None, is_refusal_tolerated=False):
        sent.append((command, argument))

    def fake_read_words(command, word_count):
        if command == _GET_ASC:
            return [1 if is_asc_enabled else 0]
        return [0] * word_count

    monkeypatch.setattr(sensor, "_send", fake_send)
    monkeypatch.setattr(sensor, "_read_words", fake_read_words)
    monkeypatch.setattr("smbus2.SMBus", lambda _bus_number: FakeBus())
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
    # The chip rejects configuration while measuring, so a later ASC write would be ignored.
    _, sent = build(False, monkeypatch)
    commands = [command for command, _ in sent]
    assert commands.index(_SET_ASC) < commands.index(_START_PERIODIC)


def test_the_applied_value_appears_in_the_startup_line(monkeypatch) -> None:
    sensor, _ = build(False, monkeypatch)
    assert "asc=off" in sensor.describe()

    enabled_sensor, _ = build(True, monkeypatch)
    assert "asc=ON" in enabled_sensor.describe()


def test_describe_says_unknown_before_start() -> None:
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None)
    assert "asc=?" in sensor.describe()
