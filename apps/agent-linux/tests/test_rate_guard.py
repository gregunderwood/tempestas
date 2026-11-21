"""Impossible changes the range guard cannot see, using jumps the sensor produced on 2026-09-13."""

from __future__ import annotations

from tempestas_agent.sensor import RateGuard


def test_the_first_reading_is_always_accepted() -> None:
    guard = RateGuard()
    assert guard.judge(1000, 0.0) == (True, None)


def test_a_normal_change_passes() -> None:
    guard = RateGuard(400.0)
    guard.judge(1000, 0.0)
    assert guard.judge(1017, 10.0)[0] is True  # 102 ppm/min, the fastest real bulk rate


def test_healthy_sensor_noise_is_not_refused() -> None:
    # Known-good per-sample rates reach 285 ppm/min at p99 over a 10-second window.
    guard = RateGuard(400.0)
    guard.judge(1000, 0.0)
    assert guard.judge(1048, 10.0)[0] is True, "288 ppm/min is normal sensor noise"
    tight_guard = RateGuard(200.0)
    tight_guard.judge(1000, 0.0)
    assert tight_guard.judge(1048, 10.0)[0] is False, "which 200 would have refused"


def test_the_real_spikes_are_refused() -> None:
    # 154 ppm in 20 s = 462 ppm/min. Observed at 11:09:43.
    guard = RateGuard(400.0)
    guard.judge(1068, 0.0)
    is_accepted, reason = guard.judge(914, 20.0)
    assert is_accepted is False
    assert "RATE_IMPLAUSIBLE" in (reason or "")


def test_a_spike_does_not_become_the_new_reference() -> None:
    # Keeping a refused value as the baseline would make the next good reading look like a jump.
    guard = RateGuard(400.0)
    guard.judge(1068, 0.0)
    assert guard.judge(914, 20.0)[0] is False  # spike, refused
    assert guard.judge(1070, 40.0)[0] is True  # back to normal, still fine


def test_a_genuine_step_is_accepted_within_a_few_samples() -> None:
    # The per-minute limit grows as the last accepted reading recedes, not the resync path.
    guard = RateGuard(400.0, resync_after=3)
    guard.judge(1500, 0.0)
    assert guard.judge(1350, 10.0)[0] is False
    assert guard.judge(1348, 20.0)[0] is False
    assert guard.judge(1352, 30.0)[0] is True, "a real step is back inside the limit"
    assert guard.judge(1349, 40.0)[0] is True
    assert guard.judge(1351, 50.0)[0] is True


def test_a_spewing_sensor_never_gets_its_garbage_believed() -> None:
    # On 2026-09-15 an unconditional re-baseline after three refusals let 3647 ppm through.
    guard = RateGuard(400.0, resync_after=3)
    guard.judge(378, 0.0)
    for sample_number, value in enumerate([3600, 3400, 3647, 2900, 3100], start=1):
        is_accepted, _ = guard.judge(value, sample_number * 10.0)
        assert is_accepted is False, f"{value} ppm must never be believed"

    # 2 ppm from where the sensor was before it started spewing.
    assert guard.judge(380, 60.0)[0] is True


def test_corroboration_believes_a_candidate_that_repeats() -> None:
    guard = RateGuard(400.0, resync_after=2, corroborate_within=60)
    guard.judge(2000, 0.0)
    assert guard.judge(500, 5.0)[0] is False  # far outside, even over 5 s
    assert guard.judge(505, 10.0)[0] is False  # candidate proposed
    assert guard.judge(495, 15.0)[0] is True  # corroborated within 60 ppm


def test_a_long_gap_re_baselines_instead_of_refusing() -> None:
    # Refusing here would blank the sensor on every restart.
    guard = RateGuard(max_gap_s=120)
    guard.judge(500, 0.0)
    assert guard.judge(1500, 600.0)[0] is True


def test_time_going_backwards_does_not_divide_by_zero() -> None:
    guard = RateGuard()
    guard.judge(1000, 100.0)
    assert guard.judge(1200, 100.0)[0] is True
    assert guard.judge(1200, 50.0)[0] is True


def test_the_worst_observed_jump() -> None:
    # 489 ppm between consecutive samples - 2934 ppm/min.
    guard = RateGuard()
    guard.judge(1000, 0.0)
    is_accepted, reason = guard.judge(1489, 10.0)
    assert is_accepted is False
    assert "2934" in (reason or "")
