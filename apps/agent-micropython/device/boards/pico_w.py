"""Raspberry Pi Pico W: an RP2040 with a CYW43439 radio. Deployed to the board as board.py."""

import machine

SIO_BASE = 0xD0000000
GPIO_OUT_REGISTER = SIO_BASE + 0x010
GPIO_OUTPUT_ENABLE_REGISTER = SIO_BASE + 0x020
WATCHDOG_CONTROL_REGISTER = 0x40058000
WATCHDOG_ENABLE_BIT = 1 << 30
WIFI_POWER_SAVE_OFF = 0xA11140


def is_pin_driven(pin):
    return bool(machine.mem32[GPIO_OUTPUT_ENABLE_REGISTER] & 1 << pin)


def is_pin_driven_high(pin):
    return bool(machine.mem32[GPIO_OUT_REGISTER] & 1 << pin)


def keep_wifi_awake(wifi):
    wifi.config(pm=WIFI_POWER_SAVE_OFF)


def refuse_if_watchdog_armed():
    # Once armed it cannot be stopped, and it would reset the board halfway through a copy.
    if machine.mem32[WATCHDOG_CONTROL_REGISTER] & WATCHDOG_ENABLE_BIT:
        raise RuntimeError("watchdog already armed: missed the boot grace, run the deploy again")
