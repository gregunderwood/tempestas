"""Talking to systemd, and refusing to be started twice."""

from __future__ import annotations

import fcntl
import logging
import os
import socket
import subprocess
from pathlib import Path

log = logging.getLogger("tempestas.agent")

AGENT_SERVICE = "tempestas-agent"
SYSTEMCTL_TIMEOUT_S = 5
ABSTRACT_SOCKET_MARKER = "@"
UNKNOWN_HOLDER = "unknown"
# Only a definite stop frees the sensor; any other answer may mean the agent holds it.
STOPPED_STATES = frozenset({"inactive", "failed"})
RUNNING_STATES = frozenset(
    {"active", "activating", "deactivating", "reloading", "refreshing", "maintenance"}
)
DOCUMENTED_STATES = STOPPED_STATES | RUNNING_STATES


def sd_notify(state: str) -> bool:
    address = os.environ.get("NOTIFY_SOCKET")
    if not address:
        return False
    if address.startswith(ABSTRACT_SOCKET_MARKER):
        # systemd spells the abstract namespace with '@'; Python spells it with a leading NUL.
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify_socket:
            notify_socket.connect(address)
            notify_socket.sendall(state.encode())
        return True
    except OSError as error:
        # Never fatal: failing to report readiness is much less bad than not running.
        log.warning("could not notify systemd: %s", error)
        return False


def is_agent_service_active() -> bool:
    state = read_agent_service_state()
    if state is None:
        return True
    if state not in DOCUMENTED_STATES:
        log.warning(
            "systemd gave no usable state for %s (%r), assuming it is running", AGENT_SERVICE, state
        )
    return state not in STOPPED_STATES


def read_agent_service_state() -> str | None:
    try:
        completed = subprocess.run(
            ["systemctl", "is-active", AGENT_SERVICE],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as error:
        log.warning(
            "could not ask systemd about %s, assuming it is running: %s", AGENT_SERVICE, error
        )
        return None
    return completed.stdout.strip()


class AlreadyRunning(RuntimeError):
    """Another agent holds the lock for this node."""


class SingleInstance:
    """An advisory flock, held for the life of the process."""

    def __init__(self, path: str | Path):
        self._path = Path(path)
        self._handle = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = self._path.open("a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            holder = _read_holder_pid(handle)
            handle.close()
            raise AlreadyRunning(
                f"another agent already holds {self._path} (pid {holder}); "
                f"two agents on one node_id fight over the same MQTT client id"
            ) from error
        _record_own_pid(handle)
        self._handle = handle

    def release(self) -> None:
        if self._handle is None:
            return
        fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        self._handle.close()
        self._handle = None

    def __enter__(self) -> SingleInstance:
        self.acquire()
        return self

    def __exit__(self, *_exception_details) -> None:
        self.release()


def _read_holder_pid(handle) -> str:
    handle.seek(0)
    return handle.read().strip() or UNKNOWN_HOLDER


def _record_own_pid(handle) -> None:
    handle.seek(0)
    handle.truncate()
    handle.write(str(os.getpid()))
    handle.flush()
