"""Talking to systemd, and refusing to be started twice.

Both of these exist because of specific failures rather than tidiness:

  * `Type=notify` replaces the old system's unconditional `sleep 5` in the app
    and `sleep 15` in the unit. Sleeping is a guess; readiness is a fact, and
    anything ordered after this unit deserves the fact.
  * The single-instance lock exists because two agents sharing a `node_id` fight
    over one MQTT client id: the broker evicts the older one, its will fires, and
    the two then alternate `hello`s with different boot ids - which reads in the
    server log as a node rebooting in a loop. That happened during development
    and took a while to see. The lock makes it impossible rather than unlikely.
"""

from __future__ import annotations

import fcntl
import logging
import os
import socket
from pathlib import Path

log = logging.getLogger("tempestas.agent")


def sd_notify(state: str) -> bool:
    """Send a notification to systemd. A no-op when not run by systemd."""
    address = os.environ.get("NOTIFY_SOCKET")
    if not address:
        return False
    # A leading '@' means the abstract socket namespace, which Python spells
    # with a leading NUL.
    if address.startswith("@"):
        address = "\0" + address[1:]
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.connect(address)
            sock.sendall(state.encode())
        return True
    except OSError as err:
        # Never fatal: failing to tell systemd we are ready is much less bad
        # than not running.
        log.warning("could not notify systemd: %s", err)
        return False


class AlreadyRunning(RuntimeError):
    """Another agent holds the lock for this node."""


class SingleInstance:
    """An advisory flock, held for the life of the process.

    Advisory on purpose: it also lets a CLI safely refuse to run against a live
    service, which is the same guarantee the GPIO chip handle will need.
    """

    def __init__(self, path: str | Path):
        self._path = Path(path)
        self._handle = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        handle = self._path.open("a+")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as err:
            handle.seek(0)
            holder = handle.read().strip() or "unknown"
            handle.close()
            raise AlreadyRunning(
                f"another agent already holds {self._path} (pid {holder}); "
                f"two agents on one node_id fight over the same MQTT client id"
            ) from err
        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
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

    def __exit__(self, *_exc) -> None:
        self.release()
