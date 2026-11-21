"""The single-instance lock and the systemd handshake."""

from __future__ import annotations

import os
import shutil
import socket
import tempfile

import pytest

from tempestas_agent.runtime import AlreadyRunning, SingleInstance, sd_notify

# Below the ~104-character AF_UNIX path cap, which pytest's tmp_path exceeds.
SHORT_TEMPORARY_ROOT = "/tmp"
DATAGRAM_SIZE = 64


class TestSingleInstance:
    # Two agents on one node_id fight over one MQTT client id and read as a reboot loop.
    def test_a_second_agent_is_refused(self, tmp_path):
        lock = tmp_path / "agent.lock"
        with SingleInstance(lock), pytest.raises(AlreadyRunning, match="already holds"):
            SingleInstance(lock).acquire()

    def test_the_lock_is_released_on_exit(self, tmp_path):
        lock = tmp_path / "agent.lock"
        with SingleInstance(lock):
            pass
        with SingleInstance(lock):
            pass

    def test_it_records_the_holding_pid(self, tmp_path):
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
        directory = tempfile.mkdtemp(dir=SHORT_TEMPORARY_ROOT)
        path = f"{directory}/notify.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        try:
            server.bind(path)
            monkeypatch.setenv("NOTIFY_SOCKET", path)
            assert sd_notify("READY=1") is True
            assert server.recv(DATAGRAM_SIZE) == b"READY=1"
        finally:
            server.close()
            shutil.rmtree(directory, ignore_errors=True)

    def test_a_broken_socket_is_not_fatal(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NOTIFY_SOCKET", str(tmp_path / "does-not-exist.sock"))
        assert sd_notify("READY=1") is False
