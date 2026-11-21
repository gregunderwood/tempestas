"""The single-instance lock and the systemd handshake."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile

import pytest

from tempestas_agent import runtime
from tempestas_agent.runtime import (
    AlreadyRunning,
    SingleInstance,
    is_agent_service_active,
    sd_notify,
)

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


def replace_systemctl(monkeypatch, fake_run) -> None:
    monkeypatch.setattr(runtime.subprocess, "run", fake_run)


def systemctl_answering(answer: str):
    def fake_run(command, **_options):
        return subprocess.CompletedProcess(command, returncode=0, stdout=f"{answer}\n", stderr="")

    return fake_run


def systemctl_raising(failure: Exception):
    def fake_run(_command, **_options):
        raise failure

    return fake_run


class TestIsAgentServiceActive:
    def test_an_active_service_reads_as_running(self, monkeypatch):
        replace_systemctl(monkeypatch, systemctl_answering("active"))
        assert is_agent_service_active() is True

    def test_an_inactive_service_reads_as_stopped(self, monkeypatch):
        replace_systemctl(monkeypatch, systemctl_answering("inactive"))
        assert is_agent_service_active() is False

    def test_a_failed_service_reads_as_stopped(self, monkeypatch):
        replace_systemctl(monkeypatch, systemctl_answering("failed"))
        assert is_agent_service_active() is False

    @pytest.mark.parametrize("state", ["activating", "deactivating", "reloading"])
    def test_a_service_in_transition_reads_as_running(self, monkeypatch, state):
        replace_systemctl(monkeypatch, systemctl_answering(state))
        assert is_agent_service_active() is True

    @pytest.mark.parametrize("answer", ["", "unknown"])
    def test_a_systemctl_without_an_answer_reads_as_running(self, monkeypatch, caplog, answer):
        replace_systemctl(monkeypatch, systemctl_answering(answer))
        assert is_agent_service_active() is True
        assert "assuming it is running" in caplog.text

    def test_a_missing_systemctl_reads_as_running(self, monkeypatch, caplog):
        replace_systemctl(monkeypatch, systemctl_raising(FileNotFoundError("systemctl")))
        assert is_agent_service_active() is True
        assert "assuming it is running" in caplog.text

    def test_a_documented_state_raises_no_warning(self, monkeypatch, caplog):
        replace_systemctl(monkeypatch, systemctl_answering("activating"))
        is_agent_service_active()
        assert "assuming it is running" not in caplog.text

    def test_a_systemctl_timeout_reads_as_running(self, monkeypatch):
        timeout = subprocess.TimeoutExpired(["systemctl"], runtime.SYSTEMCTL_TIMEOUT_S)
        replace_systemctl(monkeypatch, systemctl_raising(timeout))
        assert is_agent_service_active() is True

    def test_an_unrelated_bug_is_not_swallowed(self, monkeypatch):
        replace_systemctl(monkeypatch, systemctl_raising(TypeError("bad argument")))
        with pytest.raises(TypeError):
            is_agent_service_active()
