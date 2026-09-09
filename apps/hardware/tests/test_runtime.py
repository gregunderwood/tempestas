"""The single-instance lock and the systemd handshake."""

from __future__ import annotations

import pytest

from tempestas_agent.runtime import AlreadyRunning, SingleInstance, sd_notify


class TestSingleInstance:
    # Two agents sharing a node_id fight over one MQTT client id: the broker
    # evicts the older, its will fires, and the pair alternate hellos with
    # different boot ids - which reads as a node rebooting in a loop.
    def test_a_second_agent_is_refused(self, tmp_path):
        lock = tmp_path / "agent.lock"
        with SingleInstance(lock), pytest.raises(AlreadyRunning, match="already holds"):
            SingleInstance(lock).acquire()

    def test_the_lock_is_released_on_exit(self, tmp_path):
        lock = tmp_path / "agent.lock"
        with SingleInstance(lock):
            pass
        # The next one gets it without complaint.
        with SingleInstance(lock):
            pass

    def test_it_records_the_holding_pid(self, tmp_path):
        import os

        lock = tmp_path / "agent.lock"
        with SingleInstance(lock):
            assert lock.read_text().strip() == str(os.getpid())

    def test_it_creates_the_runtime_directory(self, tmp_path):
        lock = tmp_path / "nested" / "dir" / "agent.lock"
        with SingleInstance(lock):
            assert lock.exists()


class TestSdNotify:
    def test_is_a_no_op_when_not_run_by_systemd(self, monkeypatch):
        monkeypatch.delenv("NOTIFY_SOCKET", raising=False)
        assert sd_notify("READY=1") is False

    def test_sends_to_the_socket_systemd_provides(self, monkeypatch):
        import shutil
        import socket as socket_mod
        import tempfile

        # A short directory on purpose: an AF_UNIX path is capped near 104
        # characters and pytest's tmp_path is comfortably longer than that.
        directory = tempfile.mkdtemp(dir="/tmp")
        path = f"{directory}/n.sock"
        server = socket_mod.socket(socket_mod.AF_UNIX, socket_mod.SOCK_DGRAM)
        try:
            server.bind(path)
            monkeypatch.setenv("NOTIFY_SOCKET", path)
            assert sd_notify("READY=1") is True
            assert server.recv(64) == b"READY=1"
        finally:
            server.close()
            shutil.rmtree(directory, ignore_errors=True)

    # Failing to tell systemd we are ready is much less bad than not running.
    def test_a_broken_socket_is_not_fatal(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NOTIFY_SOCKET", str(tmp_path / "does-not-exist.sock"))
        assert sd_notify("READY=1") is False
