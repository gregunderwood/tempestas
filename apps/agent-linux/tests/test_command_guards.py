"""The guards on the command path: each refuses something that could energise a propane burner."""

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
    assert judge(command()).is_accepted is True


def test_refuses_a_retained_command_and_alarms():
    verdict = judge(command(), retained=True)
    assert verdict.is_accepted is False
    assert verdict.alarm == contract.AlarmCode.RETAINED_COMMAND_DROPPED


# The retain flag is only set on a new subscription, so ownership is what protects the relay.
def test_refuses_a_command_from_a_controller_we_are_not_bound_to():
    verdict = judge(command(issuedBy="attacker"))
    assert verdict.is_accepted is False
    assert verdict.alarm == contract.AlarmCode.CONTROLLER_CONFLICT


def test_accepts_any_issuer_before_we_have_been_bound():
    # Refusing everything before the first heartbeat would leave a node uncommandable.
    assert judge(command(issuedBy="whoever"), bound=None).is_accepted is True


def test_refuses_an_expired_command_and_alarms():
    stale = command(expiresAt=(NOW - timedelta(seconds=1)).isoformat().replace("+00:00", "Z"))
    verdict = judge(stale)
    assert verdict.is_accepted is False
    assert verdict.alarm == contract.AlarmCode.COMMAND_EXPIRED


def test_refuses_a_command_with_no_expiry():
    body = json.loads(command())
    del body["expiresAt"]
    assert judge(json.dumps(body).encode()).is_accepted is False


# An empty payload clears a retained command; alarming on it risks a loop against the clearer.
def test_ignores_an_empty_payload_silently():
    verdict = judge(b"")
    assert verdict.is_accepted is False
    assert verdict.alarm is None
    assert judge(b"   ").alarm is None


def test_refuses_an_unknown_schema_major():
    assert judge(command(schema="gpioSet/2")).is_accepted is False
    assert judge(command(schema="nonsense")).is_accepted is False


def test_refuses_malformed_payloads():
    assert judge(b"not json").is_accepted is False
    assert judge(b"[1,2,3]").is_accepted is False
    assert judge(b'{"schema":"gpioSet/1"}').is_accepted is False


def test_refuses_a_command_with_no_lines():
    assert judge(command(lines=[])).is_accepted is False
