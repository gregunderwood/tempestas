"""The node's half of `update`; mirrors judgeUpdateCommand, plus a refusal before NTP sets the clock."""

import json

import contract
from command_guard import parse_json_object
from iso_time import parse_iso

ANSWER_LOG = "log"
ANSWER_ALARM = "alarm"
ANSWER_FAILED_STATUS = "failed-status"
AGENT_APPS = ("agent-linux", "agent-micropython")
MANIFEST_URL_PREFIXES = ("http://", "https://")
SHA256_HEX_LENGTH = 64
HEX_DIGITS = "0123456789abcdef"
VERSION_PART_COUNT = 3


class UpdateVerdict:
    def __init__(self, is_accepted, answer=None, reason=None, alarm_code=None, command_id=None, command=None):
        self.is_accepted = is_accepted
        self.answer = answer
        self.reason = reason
        self.alarm_code = alarm_code
        self.command_id = command_id
        self.command = command


def log_only(reason):
    return UpdateVerdict(False, ANSWER_LOG, reason)


def alarm(reason, alarm_code):
    return UpdateVerdict(False, ANSWER_ALARM, reason, alarm_code)


def judge_update_command(payload, is_retained, bound_controller, now_seconds, running_app):
    if payload.strip() == b"":
        # Reacting to a clear, even with an alarm, risks a loop.
        return log_only("empty payload (a retained clear)")
    if is_retained:
        return alarm("update carried the retain flag", contract.AlarmCode.RETAINED_COMMAND_DROPPED)

    body = parse_json_object(payload)
    if body is None:
        return log_only("payload is not a JSON object")
    if contract.read_schema_major(body.get("schema")) != contract.SUPPORTED_MAJOR:
        return log_only("unsupported schema %r" % body.get("schema"))

    ownership_refusal = judge_ownership(body.get("issuedBy"), bound_controller)
    if ownership_refusal is not None:
        return ownership_refusal
    if now_seconds is None:
        return log_only("clock not set yet, so expiresAt cannot be judged")
    expiry_refusal = judge_expiry(body.get("expiresAt"), now_seconds)
    if expiry_refusal is not None:
        return expiry_refusal

    command_id = body.get("id")
    if not isinstance(command_id, str) or command_id == "":
        return log_only("update has no id")
    target_problem = describe_target_problem(body, running_app)
    if target_problem is not None:
        return UpdateVerdict(False, ANSWER_FAILED_STATUS, target_problem, command_id=command_id)
    return UpdateVerdict(True, command_id=command_id, command=body)


def judge_ownership(issued_by, bound_controller):
    # Stricter than gpio/set: an update can wait for the first heartbeat.
    if bound_controller is None:
        return log_only("no controller is bound yet")
    if issued_by != bound_controller:
        return alarm(
            "issuedBy %s is not the bound controller %s"
            % (json.dumps(issued_by), json.dumps(bound_controller)),
            contract.AlarmCode.CONTROLLER_CONFLICT,
        )
    return None


def judge_expiry(expires_at, now_seconds):
    if not isinstance(expires_at, str):
        return log_only("update has no expiresAt")
    deadline = parse_iso(expires_at)
    if deadline is None:
        return log_only("unparseable expiresAt %s" % json.dumps(expires_at))
    if deadline < now_seconds:
        return alarm("update expired", contract.AlarmCode.COMMAND_EXPIRED)
    return None


def describe_target_problem(body, running_app):
    app = body.get("app")
    if app not in AGENT_APPS:
        return "unknown app %s" % json.dumps(app)
    if app != running_app:
        return "update is for %s, this node runs %s" % (app, running_app)
    version = body.get("version")
    version_major = read_version_major(version)
    if version_major is None:
        return "unparseable version %s" % json.dumps(version)
    if version_major != contract.SUPPORTED_MAJOR:
        return "version %s is for contract major %d, this node speaks %d" % (
            version,
            version_major,
            contract.SUPPORTED_MAJOR,
        )
    if not is_fetchable_url(body.get("manifestUrl")):
        return "manifestUrl %s is not an http(s) URL" % json.dumps(body.get("manifestUrl"))
    if not is_sha256_hex(body.get("manifestSha256")):
        return "manifestSha256 is not 64 lowercase hex digits"
    return None


def read_version_major(version):
    if not isinstance(version, str):
        return None
    numbers = version.partition("-")[0].split(".")
    if len(numbers) != VERSION_PART_COUNT or not all(is_decimal(number) for number in numbers):
        return None
    return int(numbers[0])


def is_decimal(text):
    return len(text) > 0 and all(character in "0123456789" for character in text)


def is_fetchable_url(value):
    if not isinstance(value, str):
        return False
    for prefix in MANIFEST_URL_PREFIXES:
        if value.startswith(prefix):
            return value[len(prefix) :].partition("/")[0] != ""
    return False


def is_sha256_hex(value):
    return (
        isinstance(value, str)
        and len(value) == SHA256_HEX_LENGTH
        and all(character in HEX_DIGITS for character in value)
    )
