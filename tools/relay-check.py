"""Bench instrument: drive one relay line from the real backend and hold it.

    python relay-check.py                  # everything off
    python relay-check.py 6                # BCM 6 energised, the other two off
    python relay-check.py 5 --burner       # BCM 5 drives the CO2 generator

Every run claims all three lines at their failsafe first, so at most one relay is
on. The pad holds its level after exit (docs/Safety.md). Not for use beside a live
agent: the kernel refuses the second claimant, and that refusal is the point.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps/agent-linux/src"))

from tempestas_agent import gpio  # noqa: E402

# As wired on elantris; the BCM-to-channel mapping is a permutation, see docs/Hardware.md.
CHANNEL = {
    5: "relay 6 (In6, pin 29)",
    6: "relay 7 (In7, pin 31)",
    4: "relay 8 (In8, pin 7)",
}
LINES = tuple(CHANNEL)
ENERGISED_LEVEL = 0
DE_ENERGISED_LEVEL = 1
FAILSAFE = dict.fromkeys(LINES, DE_ENERGISED_LEVEL)
CHIP_LABEL = "pinctrl-bcm2711"
USAGE_ERROR = 2

# docs/Safety.md: an on-demand tool refuses the propane burner's line unless asked by name.
BURNER_LINE = 5
BURNER_FLAG = "--burner"


def describe_level(level: int | None) -> str:
    if level == ENERGISED_LEVEL:
        return "ON"
    if level == DE_ENERGISED_LEVEL:
        return "off"
    return "UNKNOWN"


def refuse_request(requested_pin: int, is_burner_confirmed: bool) -> str | None:
    if requested_pin not in CHANNEL:
        return f"BCM {requested_pin} is not one of the wired lines {sorted(CHANNEL)}"
    if requested_pin == BURNER_LINE and not is_burner_confirmed:
        return (
            f"BCM {BURNER_LINE} is {CHANNEL[BURNER_LINE]}, which switches the CO2 "
            f"generator. Pass {BURNER_FLAG} if that is what you mean."
        )
    return None


def main(argv: list[str]) -> int:
    positional = [argument for argument in argv if argument != BURNER_FLAG]
    is_burner_confirmed = BURNER_FLAG in argv

    requested_pin: int | None = None
    if positional:
        requested_pin = int(positional[0])
        refusal = refuse_request(requested_pin, is_burner_confirmed)
        if refusal:
            print(refusal, file=sys.stderr)
            return USAGE_ERROR

    backend = gpio.build(LINES, CHIP_LABEL, simulated=False)
    try:
        backend.claim(LINES, FAILSAFE)
    except gpio.GpioBusy as error:
        print(
            f"{error}\n\nIs tempestas-agent running? `systemctl stop tempestas-agent`",
            file=sys.stderr,
        )
        return 1
    if requested_pin is not None:
        backend.write(requested_pin, ENERGISED_LEVEL)

    for pin in LINES:
        level = backend.level(pin)
        print(f"BCM {pin}  {CHANNEL[pin]:<24} level={level}  {describe_level(level)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
