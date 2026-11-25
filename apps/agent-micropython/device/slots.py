"""Which slot boots. The bootloader and the agent share this file, so it is never updated over the air."""

import json
import os

DEVICE_ROOT = "/"
SLOT_NAMES = ("a", "b")
STATE_FILE = "slots.json"
MAX_BOOT_ATTEMPTS = 3
HEALTHY = "healthy"
ROLLED_BACK = "rolled-back"


def join_path(directory, name):
    return directory.rstrip("/") + "/" + name


def find_other_slot(slot):
    return SLOT_NAMES[1] if slot == SLOT_NAMES[0] else SLOT_NAMES[0]


def build_outcome(command_id, state, reason=None):
    return {"commandId": command_id, "state": state, "reason": reason}


class SlotStore:
    def __init__(self, root=DEVICE_ROOT):
        self.root = root

    def locate(self, name):
        return join_path(self.root, name)

    def read(self):
        try:
            with open(self.locate(STATE_FILE)) as file:
                state = json.load(file)
        except (OSError, ValueError):
            return None
        if not isinstance(state, dict) or state.get("active") not in SLOT_NAMES:
            return None
        if not is_countable_pending(state.get("pending"), state["active"]):
            # Dropped rather than refused, so the known-good slot still boots.
            state["pending"] = None
        if not isinstance(state.get("outcome"), dict):
            state["outcome"] = None
        return state

    def write(self, state):
        # Renamed into place, so a power cut leaves the old state or the new, never half of one.
        unfinished = self.locate(STATE_FILE + ".new")
        with open(unfinished, "w") as file:
            json.dump(state, file)
        os.rename(unfinished, self.locate(STATE_FILE))

    def start_pending(self, slot, command_id, version):
        state = self.read()
        state["pending"] = {"slot": slot, "commandId": command_id, "version": version, "attempts": 0}
        state["outcome"] = None
        self.write(state)

    def keep_pending(self):
        state = self.read()
        pending = state["pending"]
        state["active"] = pending["slot"]
        state["pending"] = None
        state["outcome"] = build_outcome(pending["commandId"], HEALTHY)
        self.write(state)

    def abandon_pending(self, reason):
        state = self.read()
        state["outcome"] = build_outcome(state["pending"]["commandId"], ROLLED_BACK, reason)
        state["pending"] = None
        self.write(state)

    def clear_outcome(self):
        state = self.read()
        state["outcome"] = None
        self.write(state)


def is_countable_pending(pending, active):
    return (
        isinstance(pending, dict)
        and pending.get("slot") in SLOT_NAMES
        and pending.get("slot") != active
        and isinstance(pending.get("attempts"), int)
        and isinstance(pending.get("version"), str)
        and isinstance(pending.get("commandId"), str)
    )


def choose_slot_to_boot(store):
    state = store.read()
    if state is None:
        return None
    if state["pending"] is None:
        return state["active"]
    try:
        return count_boot_attempt(store, state)
    except OSError:
        # Flash that cannot be written must not leave the node in the REPL, so the known-good slot runs.
        return state["active"]


def count_boot_attempt(store, state):
    pending = state["pending"]
    if pending["attempts"] >= MAX_BOOT_ATTEMPTS:
        store.abandon_pending(
            "%s did not come up healthy in %d boots" % (pending["version"], MAX_BOOT_ATTEMPTS)
        )
        return state["active"]
    # Counted before the slot runs, so a crash or a watchdog reset uses up an attempt too.
    pending["attempts"] += 1
    store.write(state)
    return pending["slot"]
