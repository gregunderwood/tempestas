"""Never updated over the air, so a bad release can always be rolled back or recovered over USB."""

import sys

import slots

# Raised whenever this file or slots.py changes, so a node's boot log says which bootloader it has.
BOOTLOADER_VERSION = 2
BOOT_GRACE_MILLISECONDS = 5000
GRACE_POLL_MILLISECONDS = 100
# Here rather than in the slot, so a release that never reaches its own gate still uses up its boots.
PENDING_SLOT_DEADLINE_MILLISECONDS = 600000
MILLISECONDS_PER_MINUTE = 60000


class Board:
    """What the bootloader needs from the chip, passed in so the tests run it under CPython."""

    def __init__(self, sleep_milliseconds, is_bootsel_pressed, reset, start_one_shot_timer):
        self.sleep_milliseconds = sleep_milliseconds
        self.is_bootsel_pressed = is_bootsel_pressed
        self.reset = reset
        self.start_one_shot_timer = start_one_shot_timer


def boot(board, store, run_slot, log):
    log(
        "tempestas bootloader %d: the agent starts in %d s; Ctrl-C or BOOTSEL keeps the REPL"
        % (BOOTLOADER_VERSION, BOOT_GRACE_MILLISECONDS // 1000)
    )
    if is_safe_mode_requested(board):
        log("safe mode: BOOTSEL was pressed, so no slot runs")
        return
    slot = slots.choose_slot_to_boot(store)
    if slot is None:
        log("no usable %s: deploy with tools/deploy-agent-micropython.sh" % slots.STATE_FILE)
        return
    if is_pending(store, slot):
        start_pending_deadline(board, store, slot, log)
    else:
        log("booting slot %s" % slot)
    try:
        run_slot(store.locate(slot))
    except Exception as error:
        # Reset, so a slot that fails before the watchdog is armed still uses up a boot attempt.
        log("slot %s stopped: %r" % (slot, error))
        board.reset()


def is_safe_mode_requested(board):
    # Holding BOOTSEL at power-up enters the ROM's USB flashing mode, so it is read during the grace instead.
    waited_milliseconds = 0
    while waited_milliseconds < BOOT_GRACE_MILLISECONDS:
        if board.is_bootsel_pressed():
            return True
        board.sleep_milliseconds(GRACE_POLL_MILLISECONDS)
        waited_milliseconds += GRACE_POLL_MILLISECONDS
    return False


def is_pending(store, slot):
    state = store.read()
    return state is not None and state["pending"] is not None and state["pending"]["slot"] == slot


def start_pending_deadline(board, store, slot, log):
    deadline_minutes = PENDING_SLOT_DEADLINE_MILLISECONDS // MILLISECONDS_PER_MINUTE
    log("booting pending slot %s; it resets in %d min unless kept" % (slot, deadline_minutes))

    def reset_if_still_pending(timer):
        if is_pending(store, slot):
            board.reset()

    board.start_one_shot_timer(PENDING_SLOT_DEADLINE_MILLISECONDS, reset_if_still_pending)


def is_bootsel_pressed():
    try:
        import rp2

        return rp2.bootsel_button() == 1
    except Exception:
        # A firmware without the button must still boot its slot.
        return False


def run_slot_from(slot_directory):
    # Ahead of the root, so a slot's own module always wins over a stray copy beside settings.py.
    sys.path.insert(0, slot_directory)
    import node_runtime

    node_runtime.run()
