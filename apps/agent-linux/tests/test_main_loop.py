"""The main loop keeps systemd's watchdog fed only while it is really going round."""

from __future__ import annotations

import os
import threading
from types import SimpleNamespace

from tempestas_agent import __main__ as main_module
from tempestas_agent.__main__ import read_watchdog_ping_interval_s, wait_for_next_tick

WATCHDOG_USEC_FOR_A_MINUTE = "60000000"


def make_waiting_agent():
    return SimpleNamespace(restart_requested=threading.Event())


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


def test_does_not_ping_a_watchdog_meant_for_another_process(monkeypatch):
    monkeypatch.setenv("WATCHDOG_USEC", WATCHDOG_USEC_FOR_A_MINUTE)
    monkeypatch.setenv("WATCHDOG_PID", str(os.getpid() + 1))

    assert read_watchdog_ping_interval_s() is None


def test_keeps_pinging_through_a_wait_longer_than_the_watchdog(monkeypatch):
    pings = record_pings(monkeypatch)

    wait_for_next_tick(make_waiting_agent(), interval_s=0.05, ping_interval_s=0.01)

    assert len(pings) >= 3
    assert set(pings) == {"WATCHDOG=1"}


def test_a_wait_without_a_watchdog_never_pings(monkeypatch):
    pings = record_pings(monkeypatch)

    wait_for_next_tick(make_waiting_agent(), interval_s=0.01, ping_interval_s=None)

    assert pings == []


def test_a_requested_restart_ends_the_wait_at_once(monkeypatch):
    record_pings(monkeypatch)
    agent = make_waiting_agent()
    agent.restart_requested.set()

    wait_for_next_tick(agent, interval_s=60, ping_interval_s=30)
