import json

from command_guard import judge_command
from contract import AlarmCode
from fakes import SET_CLOCK_EPOCH_SECONDS
from iso_time import format_iso

CONTROLLER = "nestjs-1"


def command(**overrides):
    body = {
        "schema": "gpioSet/1",
        "node": "braize",
        "ts": format_iso(SET_CLOCK_EPOCH_SECONDS),
        "id": "cmd-1",
        "issuedBy": CONTROLLER,
        "expiresAt": format_iso(SET_CLOCK_EPOCH_SECONDS + 30),
        "lines": [{"pin": 20, "level": 0}],
    }
    body.update(overrides)
    return json.dumps(body).encode()


def judge(payload, is_retained=False, bound_controller=CONTROLLER, now_seconds=SET_CLOCK_EPOCH_SECONDS):
    return judge_command(payload, is_retained, bound_controller, now_seconds)


def test_accepts_a_fresh_command_from_the_bound_controller():
    assert judge(command()).is_accepted


def test_ignores_an_empty_payload_without_an_alarm():
    verdict = judge(b"  ")
    assert not verdict.is_accepted
    assert verdict.alarm_code is None


def test_drops_a_retained_command_loudly():
    verdict = judge(command(), is_retained=True)
    assert not verdict.is_accepted
    assert verdict.alarm_code == AlarmCode.RETAINED_COMMAND_DROPPED


def test_refuses_a_foreign_controller():
    verdict = judge(command(issuedBy="intruder"))
    assert verdict.alarm_code == AlarmCode.CONTROLLER_CONFLICT


def test_refuses_an_expired_command():
    verdict = judge(command(expiresAt=format_iso(SET_CLOCK_EPOCH_SECONDS - 1)))
    assert verdict.alarm_code == AlarmCode.COMMAND_EXPIRED


def test_refuses_every_command_until_the_clock_is_set():
    verdict = judge(command(), now_seconds=None)
    assert not verdict.is_accepted
    assert verdict.alarm_code is None
    assert "clock" in verdict.reason


def test_refuses_malformed_commands_quietly():
    malformed = [
        b"not json",
        b"[1, 2]",
        command(schema="gpioSet/2"),
        command(expiresAt="soon"),
        command(lines=[]),
        command(id=7),
    ]
    for payload in malformed:
        verdict = judge(payload)
        assert not verdict.is_accepted
        assert verdict.alarm_code is None
