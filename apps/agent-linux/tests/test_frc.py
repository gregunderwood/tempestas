"""Forced recalibration: the repair for a baseline that has gone wrong."""

from __future__ import annotations

import pytest

from tempestas_agent.sensor import _PERFORM_FRC, _START_PERIODIC, _STOP_PERIODIC, Scd4xSensor


def build(monkeypatch, response: int):
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None)
    sent: list[tuple[int, int | None]] = []

    def fake_send(cmd, arg=None, exec_ms=1, tolerate=False):
        sent.append((cmd, arg))

    def fake_read_words(cmd, nwords, exec_ms=1, arg=None):
        sent.append((cmd, arg))
        return [response]

    monkeypatch.setattr(sensor, "_send", fake_send)
    monkeypatch.setattr(sensor, "_read_words", fake_read_words)
    return sensor, sent


def test_returns_the_applied_correction(monkeypatch) -> None:
    # The chip offsets the correction by 0x8000 so an unsigned word can carry a
    # negative one. 0x8000 + 115 means "I was reading 115 ppm high".
    sensor, _ = build(monkeypatch, 0x8000 + 115)
    assert sensor.forced_recalibration(425) == 115


def test_a_negative_correction_comes_back_negative(monkeypatch) -> None:
    sensor, _ = build(monkeypatch, 0x8000 - 60)
    assert sensor.forced_recalibration(425) == -60


def test_the_target_is_actually_sent(monkeypatch) -> None:
    sensor, sent = build(monkeypatch, 0x8000)
    sensor.forced_recalibration(425)
    assert (_PERFORM_FRC, 425) in sent, "the reference value must reach the chip"


def test_measurement_is_stopped_first_and_restarted_after(monkeypatch) -> None:
    # The chip rejects configuration while sampling, so an FRC issued during
    # periodic measurement is silently useless.
    sensor, sent = build(monkeypatch, 0x8000)
    sensor.forced_recalibration(425)
    cmds = [c for c, _ in sent]
    assert cmds.index(_STOP_PERIODIC) < cmds.index(_PERFORM_FRC)
    assert cmds.index(_PERFORM_FRC) < cmds.index(_START_PERIODIC)


def test_rejection_raises_rather_than_reporting_a_bogus_correction(monkeypatch) -> None:
    # 0xFFFF is the chip refusing. Subtracting 0x8000 from it would yield a
    # plausible-looking 32767 ppm correction and silently ruin the sensor.
    sensor, _ = build(monkeypatch, 0xFFFF)
    with pytest.raises(OSError, match="REJECTED"):
        sensor.forced_recalibration(425)


def test_measurement_restarts_even_though_it_then_raises(monkeypatch) -> None:
    sensor, sent = build(monkeypatch, 0xFFFF)
    with pytest.raises(OSError):
        sensor.forced_recalibration(425)
    assert _START_PERIODIC in [c for c, _ in sent], "must not leave it stopped"
