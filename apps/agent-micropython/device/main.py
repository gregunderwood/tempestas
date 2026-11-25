import time

import machine

import bootloader
import slots


def is_bootsel_pressed():
    try:
        import rp2
    except ImportError:
        return False
    return rp2.bootsel_button() == 1


board = bootloader.Board(time.sleep_ms, is_bootsel_pressed, machine.reset)
bootloader.boot(board, slots.SlotStore(), bootloader.run_slot_from, print)
