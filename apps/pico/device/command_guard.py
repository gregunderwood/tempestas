"""Whether a gpio/set may be obeyed. Pure, so every refusal can be asserted in a test.

The checks mirror apps/hardware's judge_command, cheapest and most dangerous first, plus one
the Pi does not need: a Pico has no real-time clock, so until NTP has set it a command's
expiresAt cannot be judged, and an unjudgeable command is refused.
"""

import json

import contract
from iso_time import parse_iso


class CommandVerdict:
    def __init__(self, is_accepted, reason=None, alarm_code=None):
        self.is_accepted = is_accepted
        self.reason = reason
        self.alarm_code = alarm_code


def accept():
    return CommandVerdict(True)


def refuse(reason, alarm_code=None):
    return CommandVerdict(False, reason, alarm_code)


def judge_command(payload, is_retained, bound_controller, now_seconds):
    if payload.strip() == b"":
        return refuse("empty payload (a retained clear)")
    if is_retained:
        return refuse("command carried the retain flag", contract.AlarmCode.RETAINED_COMMAND_DROPPED)

    body = parse_json_object(payload)
    if body is None:
        return refuse("payload is not a JSON object")
    if contract.read_schema_major(body.get("schema")) != contract.SUPPORTED_MAJOR:
        return refuse("unsupported schema " + repr(body.get("schema")))

    issued_by = body.get("issuedBy")
    if bound_controller is not None and issued_by != bound_controller:
        return refuse(
            "issuedBy %r is not the bound controller %r" % (issued_by, bound_controller),
            contract.AlarmCode.CONTROLLER_CONFLICT,
        )

    if now_seconds is None:
        return refuse("clock not set yet, so expiresAt cannot be judged")
    deadline = parse_iso(body.get("expiresAt"))
    if deadline is None:
        return refuse("command has no readable expiresAt")
    if deadline < now_seconds:
        return refuse("command expired", contract.AlarmCode.COMMAND_EXPIRED)

    if not has_lines(body):
        return refuse("command has no lines")
    if not isinstance(body.get("id"), str):
        return refuse("command has no id")
    return accept()


def parse_json_object(payload):
    try:
        body = json.loads(payload)
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def has_lines(body):
    lines = body.get("lines")
    return isinstance(lines, list) and len(lines) > 0
