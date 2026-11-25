import time

import machine

import bootloader
import slots

# Held here, as a timer that is garbage collected never fires.
started_timers = []


def start_one_shot_timer(milliseconds, callback):
    started_timers.append(machine.Timer(mode=machine.Timer.ONE_SHOT, period=milliseconds, callback=callback))


board = bootloader.Board(time.sleep_ms, bootloader.is_bootsel_pressed, machine.reset, start_one_shot_timer)
bootloader.boot(board, slots.SlotStore(), bootloader.run_slot_from, print)
