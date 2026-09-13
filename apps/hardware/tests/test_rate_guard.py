"""Impossible CHANGES, which the range guard cannot see.

Every jump here is one the sensor actually produced on 2026-09-13, all of them
inside 400-5000 ppm and therefore invisible to the range check.
"""

from __future__ import annotations

from tempestas_agent.sensor import RateGuard


def test_the_first_reading_is_always_accepted() -> None:
    g = RateGuard()
    assert g.judge(1000, 0.0) == (True, None)


def test_a_normal_change_passes() -> None:
    g = RateGuard(400.0)
    g.judge(1000, 0.0)
    assert g.judge(1017, 10.0)[0] is True     # 102 ppm/min, the fastest real bulk rate


def test_healthy_sensor_noise_is_not_refused() -> None:
    # The calibration that matters. On a KNOWN-GOOD day, per-sample rates reach
    # 285 ppm/min at p99 and peak near 390, because a 10-second window
    # amplifies quantisation noise. A 200 ppm/min limit refused 2.8% of that
    # clean day - more than it refused of a degraded one.
    g = RateGuard(400.0)
    g.judge(1000, 0.0)
    assert g.judge(1048, 10.0)[0] is True, "288 ppm/min is normal sensor noise"
    g2 = RateGuard(200.0)
    g2.judge(1000, 0.0)
    assert g2.judge(1048, 10.0)[0] is False, "which 200 would have refused" 


def test_the_real_spikes_are_refused() -> None:
    # 154 ppm in 20 s = 462 ppm/min. Observed at 11:09:43.
    g = RateGuard(400.0)
    g.judge(1068, 0.0)
    ok, reason = g.judge(914, 20.0)
    assert ok is False
    assert "RATE_IMPLAUSIBLE" in (reason or "")


def test_a_spike_does_not_become_the_new_reference() -> None:
    # THE case that makes a naive guard useless: if the rejected value is kept
    # as the baseline, the next good reading looks like a jump away from it and
    # gets rejected too, and one bad sample drags the guard along behind it.
    g = RateGuard(400.0)
    g.judge(1068, 0.0)
    assert g.judge(914, 20.0)[0] is False     # spike, refused
    assert g.judge(1070, 40.0)[0] is True     # back to normal, still fine


def test_a_genuine_step_resyncs_rather_than_blanking_the_sensor() -> None:
    # A forced recalibration moves the whole scale at once. A guard that never
    # re-baselines would refuse every reading afterwards, forever.
    g = RateGuard(400.0, resync_after=3)
    g.judge(1500, 0.0)
    assert g.judge(1350, 10.0)[0] is False
    assert g.judge(1352, 20.0)[0] is False
    assert g.judge(1351, 30.0)[0] is True, "third consecutive refusal re-baselines"
    assert g.judge(1353, 40.0)[0] is True, "and it carries on from the new scale"


def test_a_long_gap_re_baselines_instead_of_refusing() -> None:
    # After an agent restart the previous reading is minutes old and no basis
    # for comparison. Refusing here would blank the sensor on every restart.
    g = RateGuard(max_gap_s=120)
    g.judge(500, 0.0)
    assert g.judge(1500, 600.0)[0] is True


def test_time_going_backwards_does_not_divide_by_zero() -> None:
    g = RateGuard()
    g.judge(1000, 100.0)
    assert g.judge(1200, 100.0)[0] is True
    assert g.judge(1200, 50.0)[0] is True


def test_the_worst_observed_jump() -> None:
    # 489 ppm between consecutive samples - 2934 ppm/min.
    g = RateGuard()
    g.judge(1000, 0.0)
    ok, reason = g.judge(1489, 10.0)
    assert ok is False
    assert "2934" in (reason or "")
