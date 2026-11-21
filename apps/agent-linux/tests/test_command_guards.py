"""The guards on the command path.

Each of these refuses something that could otherwise energise a propane burner.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from tempestas_agent import contract
from tempestas_agent.agent import judge_command

NOW = datetime(2026, 1, 10, 12, 0, 0, tzinfo=UTC)
CONTROLLER = "nestjs-1234"


def command(**overrides) -> bytes:
    body = {
        "schema": contract.SCHEMAS["gpioSet"],
        "node": "elantris",
        "ts": NOW.isoformat(),
        "id": "cmd-1",
        "issuedBy": CONTROLLER,
        "expiresAt": (NOW + timedelta(seconds=15)).isoformat().replace("+00:00", "Z"),
        "lines": [{"pin": 16, "level": 0}],
    }
    body.update(overrides)
    return json.dumps(body).encode()


def judge(payload: bytes, *, retained: bool = False, bound: str | None = CONTROLLER):
    return judge_command(payload, retained=retained, bound_controller=bound, now=NOW)


def test_accepts_a_well_formed_command_from_the_bound_controller():
    assert judge(command()).accept is True


# A retained command replays on every reconnect of a node that may be running a
# burner. This catches the replay-on-subscribe case.
def test_refuses_a_retained_command_and_alarms():
    verdict = judge(command(), retained=True)
    assert verdict.accept is False
    assert verdict.alarm == contract.AlarmCode.RETAINED_COMMAND_DROPPED


# THE check: the retain flag is only set when delivery is caused by a new
# subscription, so a retained command published mid-session looks ordinary.
# Ownership is what actually protects the relay.
def test_refuses_a_command_from_a_controller_we_are_not_bound_to():
    verdict = judge(command(issuedBy="attacker"))
    assert verdict.accept is False
    assert verdict.alarm == contract.AlarmCode.CONTROLLER_CONFLICT


def test_accepts_any_issuer_before_we_have_been_bound():
    # Before the first heartbeat there is no controller to compare against;
    # refusing everything would mean a node could never be commanded at all.
    assert judge(command(issuedBy="whoever"), bound=None).accept is True


def test_refuses_an_expired_command_and_alarms():
    stale = command(expiresAt=(NOW - timedelta(seconds=1)).isoformat().replace("+00:00", "Z"))
    verdict = judge(stale)
    assert verdict.accept is False
    assert verdict.alarm == contract.AlarmCode.COMMAND_EXPIRED


def test_refuses_a_command_with_no_expiry():
    body = json.loads(command())
    del body["expiresAt"]
    assert judge(json.dumps(body).encode()).accept is False


# An empty payload is how a retained command is CLEARED. Reacting to it - even
# to alarm - risks a loop against whoever is clearing it.
def test_ignores_an_empty_payload_silently():
    verdict = judge(b"")
    assert verdict.accept is False
    assert verdict.alarm is None
    assert judge(b"   ").alarm is None


def test_refuses_an_unknown_schema_major():
    assert judge(command(schema="gpioSet/2")).accept is False
    assert judge(command(schema="nonsense")).accept is False


def test_refuses_malformed_payloads():
    assert judge(b"not json").accept is False
    assert judge(b"[1,2,3]").accept is False
    assert judge(b'{"schema":"gpioSet/1"}').accept is False


def test_refuses_a_command_with_no_lines():
    assert judge(command(lines=[])).accept is False
