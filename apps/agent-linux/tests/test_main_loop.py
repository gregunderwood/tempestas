"""The main loop keeps systemd's watchdog fed only while it is really going round."""

from __future__ import annotations

import os
import threading
import time
from types import SimpleNamespace

import pytest

from tempestas_agent import __main__ as main_module
from tempestas_agent.__main__ import (
    STOP_CHECK_S,
    NetworkLoopDied,
    StopRequest,
    read_watchdog_ping_interval_s,
    require_network_loop_alive,
    wait_for_next_tick,
)

WATCHDOG_USEC_FOR_A_MINUTE = "60000000"


def make_waiting_agent():
    return SimpleNamespace(wake_main_loop=threading.Event())


def record_pings(monkeypatch) -> list[str]:
    pings: list[str] = []
    monkeypatch.setattr(main_module, "sd_notify", pings.append)
    return pings


def test_pings_at_half_the_watchdog_timeout(monkeypatch):
    monkeypatch.setenv("WATCHDOG_USEC", WATCHDOG_USEC_FOR_A_MINUTE)
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid()))

    assert read_watchdog_ping_interval_s() == 30.0


def test_does_not_ping_without_a_watchdog(monkeypatch):
    monkeypatch.delenv("WATCHDOG_USEC", raising=False)

    assert read_watchdog_ping_interval_s() is None


def test_does_not_ping_a_watchdog_with_no_timeout(monkeypatch):
    monkeypatch.setenv("WATCHDOG_USEC", "0")
    monkeypatch.delenv("WATCHDOG_PID", raising=False)

    assert read_watchdog_ping_interval_s() is None


def test_does_not_ping_a_watchdog_meant_for_another_process(monkeypatch):
    monkeypatch.setenv("WATCHDOG_USEC", WATCHDOG_USEC_FOR_A_MINUTE)
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid() + 1))

    assert read_watchdog_ping_interval_s() is None


def test_keeps_pinging_through_a_wait_longer_than_the_watchdog(monkeypatch):
    pings = record_pings(monkeypatch)

    wait_for_next_tick(make_waiting_agent(), 0.05, ping_interval_s=0.01, stop=StopRequest())

    assert len(pings) >= 3
    assert set(pings) == {"WATCHDOG=1"}


def test_a_wait_without_a_watchdog_never_pings(monkeypatch):
    pings = record_pings(monkeypatch)

    wait_for_next_tick(make_waiting_agent(), 0.01, ping_interval_s=None, stop=StopRequest())

    assert pings == []


def test_a_restart_or_a_stop_ends_the_wait_at_once(monkeypatch):
    record_pings(monkeypatch)
    agent = make_waiting_agent()
    agent.wake_main_loop.set()

    wait_for_next_tick(agent, 60, ping_interval_s=30, stop=StopRequest())


def test_a_stop_from_a_signal_ends_the_wait_within_a_second(monkeypatch):
    record_pings(monkeypatch)
    stop = StopRequest()
    threading.Timer(0.05, stop.request).start()
    started_at = time.monotonic()

    wait_for_next_tick(make_waiting_agent(), 60, ping_interval_s=None, stop=stop)

    assert time.monotonic() - started_at < STOP_CHECK_S + 0.5


def test_a_dead_network_thread_fails_the_run():
    finished_thread = threading.Thread(target=lambda: None)
    finished_thread.start()
    finished_thread.join()

    with pytest.raises(NetworkLoopDied):
        require_network_loop_alive(finished_thread)


def test_a_client_whose_loop_has_not_started_is_not_judged():
    require_network_loop_alive(None)
