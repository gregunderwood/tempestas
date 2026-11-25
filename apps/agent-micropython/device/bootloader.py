"""Never updated over the air, so a bad release can always be rolled back or recovered over USB."""

import sys

import slots

BOOT_GRACE_MILLISECONDS = 5000
GRACE_POLL_MILLISECONDS = 100


class Board:
    """What the bootloader needs from the chip, passed in so the tests run it under CPython."""

    def __init__(self, sleep_ms, is_bootsel_pressed, reset):
        self.sleep_ms = sleep_ms
        self.is_bootsel_pressed = is_bootsel_pressed
        self.reset = reset


def boot(board, store, run_slot, log):
    log(
        "tempestas agent starts in %d s; Ctrl-C or BOOTSEL keeps the REPL" % (BOOT_GRACE_MILLISECONDS // 1000)
    )
    if is_safe_mode_requested(board):
        log("safe mode: BOOTSEL was pressed, so no slot runs")
        return
    slot = slots.choose_slot_to_boot(store)
    if slot is None:
        log("no %s: deploy with tools/deploy-agent-micropython.sh" % slots.STATE_FILE)
        return
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
        board.sleep_ms(GRACE_POLL_MILLISECONDS)
        waited_milliseconds += GRACE_POLL_MILLISECONDS
    return False


def run_slot_from(slot_directory):
    # Ahead of the root, so a slot's own module always wins over a stray copy beside settings.py.
    sys.path.insert(0, slot_directory)
    import node_runtime

    node_runtime.run()
