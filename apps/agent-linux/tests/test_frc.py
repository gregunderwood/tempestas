"""Forced recalibration: the repair for a baseline that has gone wrong."""

from __future__ import annotations

import pytest

from tempestas_agent.sensor import _PERFORM_FRC, _START_PERIODIC, _STOP_PERIODIC, Scd4xSensor

CORRECTION_OFFSET = 0x8000
REJECTED = 0xFFFF


def build(monkeypatch, response: int):
    sensor = Scd4xSensor(1, 0x62, offset_c=None, altitude_m=None)
    sent: list[tuple[int, int | None]] = []

    def fake_send(command, argument=None, is_refusal_tolerated=False):
        sent.append((command, argument))

    def fake_read_words(command, word_count, argument=None):
        sent.append((command, argument))
        return [response]

    monkeypatch.setattr(sensor, "_send", fake_send)
    monkeypatch.setattr(sensor, "_read_words", fake_read_words)
    return sensor, sent


def test_returns_the_applied_correction(monkeypatch) -> None:
    sensor, _ = build(monkeypatch, CORRECTION_OFFSET + 115)
    assert sensor.forced_recalibration(425) == 115


def test_a_negative_correction_comes_back_negative(monkeypatch) -> None:
    sensor, _ = build(monkeypatch, CORRECTION_OFFSET - 60)
    assert sensor.forced_recalibration(425) == -60


def test_the_target_is_actually_sent(monkeypatch) -> None:
    sensor, sent = build(monkeypatch, CORRECTION_OFFSET)
    sensor.forced_recalibration(425)
    assert (_PERFORM_FRC, 425) in sent, "the reference value must reach the chip"


def test_measurement_is_stopped_first_and_restarted_after(monkeypatch) -> None:
    # The chip rejects configuration while sampling, so an FRC mid-measurement is useless.
    sensor, sent = build(monkeypatch, CORRECTION_OFFSET)
    sensor.forced_recalibration(425)
    commands = [command for command, _ in sent]
    assert commands.index(_STOP_PERIODIC) < commands.index(_PERFORM_FRC)
    assert commands.index(_PERFORM_FRC) < commands.index(_START_PERIODIC)


def test_rejection_raises_rather_than_reporting_a_bogus_correction(monkeypatch) -> None:
    # Subtracting the offset from a refusal would yield a plausible 32767 ppm correction.
    sensor, _ = build(monkeypatch, REJECTED)
    with pytest.raises(OSError, match="REJECTED"):
        sensor.forced_recalibration(425)


def test_measurement_restarts_even_though_it_then_raises(monkeypatch) -> None:
    sensor, sent = build(monkeypatch, REJECTED)
    with pytest.raises(OSError):
        sensor.forced_recalibration(425)
    assert _START_PERIODIC in [command for command, _ in sent], "must not leave it stopped"
