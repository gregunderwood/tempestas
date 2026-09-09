"""Bench instrument: drive one relay line from the real backend and hold it.

Stage C steps 5 and 6. This is the only thing in the repo that energises a relay
on purpose, so it is deliberately small and deliberately awkward about the one
line that matters.

    python relay-check.py                  # everything off
    python relay-check.py 6                # BCM 6 energised, the other two off
    python relay-check.py 5 --burner       # BCM 5 drives the CO2 generator

Every run claims all three lines at their failsafe first, so exactly one relay
can be on at a time and the starting state is never inherited from whatever ran
before. The pad holds its level after the process exits - measured, see
docs/Safety.md - so there is nothing to leave running.

Not for use against a live agent: it takes the same lines, and the kernel will
refuse the second claimant. That refusal is the point.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps/hardware/src"))

from tempestas_agent import gpio as g  # noqa: E402

# As wired on elantris. The mapping is a permutation; no arithmetic relates a
# BCM number to a channel. See docs/Hardware.md.
CHANNEL = {
    5: "relay 6 (In6, pin 29)",
    6: "relay 7 (In7, pin 31)",
    4: "relay 8 (In8, pin 7)",
}
LINES = tuple(CHANNEL)
FAILSAFE = dict.fromkeys(LINES, 1)  # active LOW: 1 is de-energised

# BCM 5 switches the CO2 generator's outlets, and that generator is a propane
# burner. docs/Safety.md requires an on-demand tool to refuse a hazardous line
# by default rather than rely on whoever is typing to remember which it is.
BURNER_LINE = 5


def main(argv: list[str]) -> int:
    args = [a for a in argv if a != "--burner"]
    forced = "--burner" in argv

    want: int | None = None
    if args:
        want = int(args[0])
        if want not in CHANNEL:
            print(f"BCM {want} is not one of the wired lines {sorted(CHANNEL)}", file=sys.stderr)
            return 2
        if want == BURNER_LINE and not forced:
            print(
                f"BCM {BURNER_LINE} is {CHANNEL[BURNER_LINE]}, which switches the CO2 "
                f"generator. Pass --burner if that is what you mean.",
                file=sys.stderr,
            )
            return 2

    hw = g.build(LINES, "pinctrl-bcm2711", simulated=False)
    hw.claim(LINES, FAILSAFE)
    if want is not None:
        hw.write(want, 0)  # 0 == energised

    for pin in LINES:
        level = hw.level(pin)
        state = "ON" if level == 0 else "off" if level == 1 else "UNKNOWN"
        print(f"BCM {pin}  {CHANNEL[pin]:<24} level={level}  {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
