import time

import machine

import bootloader
import slots


def is_bootsel_pressed():
    try:
        import rp2

        return rp2.bootsel_button() == 1
    except Exception:
        # A firmware without the button must still boot its slot.
        return False


board = bootloader.Board(time.sleep_ms, is_bootsel_pressed, machine.reset)
bootloader.boot(board, slots.SlotStore(), bootloader.run_slot_from, print)
