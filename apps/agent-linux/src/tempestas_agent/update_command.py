"""The node's half of `update`, judged like `gpio/set`; mirrors judgeUpdateCommand in TypeScript."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urlparse

from . import contract
from .instants import parse_instant

ANSWER_LOG = "log"
ANSWER_ALARM = "alarm"
ANSWER_FAILED_STATUS = "failed-status"
AGENT_APPS = ("agent-linux", "agent-micropython")

AGENT_VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.+-]+)?", re.ASCII)
SHA256_HEX = re.compile(r"[0-9a-f]{64}")
MANIFEST_URL_SCHEMES = ("http", "https")


@dataclass
class UpdateVerdict:
    is_accepted: bool
    answer: str | None = None
    reason: str | None = None
    alarm: str | None = None
    command_id: str | None = None
    command: dict = field(default_factory=dict)


def judge_update_command(
    payload: bytes,
    *,
    is_retained: bool,
    bound_controller: str | None,
    running_app: str,
    now: datetime,
) -> UpdateVerdict:
    if payload.strip() == b"":
        # Reacting to a clear, even by alarming, risks a loop against whoever cleared it.
        return build_log_only_verdict("empty payload (a retained clear)")
    if is_retained:
        return build_alarm_verdict(
            "update carried the retain flag", contract.AlarmCode.RETAINED_COMMAND_DROPPED
        )

    body = parse_json_object(payload)
    if body is None:
        return build_log_only_verdict("payload is not a JSON object")
    if contract.read_schema_major(body.get("schema")) != contract.SUPPORTED_MAJOR:
        return build_log_only_verdict(f"unsupported schema {body.get('schema')}")

    ownership_refusal = judge_ownership(body.get("issuedBy"), bound_controller)
    if ownership_refusal is not None:
        return ownership_refusal

    expiry_refusal = judge_expiry(body.get("expiresAt"), now)
    if expiry_refusal is not None:
        return expiry_refusal

    command_id = body.get("id")
    if not isinstance(command_id, str) or command_id == "":
        return build_log_only_verdict("update has no id")

    target_problem = describe_target_problem(body, running_app)
    if target_problem is not None:
        return UpdateVerdict(False, ANSWER_FAILED_STATUS, target_problem, command_id=command_id)
    return UpdateVerdict(True, command_id=command_id, command=body)


def read_version_major(version: str) -> int | None:
    match = AGENT_VERSION.fullmatch(version)
    return int(match.group(1)) if match else None


def judge_ownership(issued_by, bound_controller: str | None) -> UpdateVerdict | None:
    # Stricter than gpio/set: replacing code can wait the seconds until the first heartbeat binds.
    if bound_controller is None:
        return build_log_only_verdict("no controller is bound yet")
    if issued_by != bound_controller:
        return build_alarm_verdict(
            f'issuedBy {json.dumps(issued_by)} is not the bound controller "{bound_controller}"',
            contract.AlarmCode.CONTROLLER_CONFLICT,
        )
    return None


def judge_expiry(expires_at, now: datetime) -> UpdateVerdict | None:
    if not isinstance(expires_at, str):
        return build_log_only_verdict("update has no expiresAt")
    deadline = parse_instant(expires_at)
    if deadline is None:
        return build_log_only_verdict(f'unparseable expiresAt "{expires_at}"')
    if deadline < now:
        return build_alarm_verdict("update expired", contract.AlarmCode.COMMAND_EXPIRED)
    return None


def describe_target_problem(body: dict, running_app: str) -> str | None:
    app = body.get("app")
    if app not in AGENT_APPS:
        return f"unknown app {json.dumps(app)}"
    if app != running_app:
        return f"update is for {app}, this node runs {running_app}"
    version = body.get("version")
    version_major = read_version_major(version) if isinstance(version, str) else None
    if version_major is None:
        return f"unparseable version {json.dumps(version)}"
    if version_major != contract.SUPPORTED_MAJOR:
        return (
            f"version {version} is for contract major {version_major}, "
            f"this node speaks {contract.SUPPORTED_MAJOR}"
        )
    if not is_fetchable_url(body.get("manifestUrl")):
        return f"manifestUrl {json.dumps(body.get('manifestUrl'))} is not an http(s) URL"
    manifest_sha256 = body.get("manifestSha256")
    if not isinstance(manifest_sha256, str) or not SHA256_HEX.fullmatch(manifest_sha256):
        return "manifestSha256 is not 64 lowercase hex digits"
    return None


def is_fetchable_url(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = urlparse(value)
    except ValueError:
        # Raised on the network thread, it would leave the agent deaf.
        return False
    return parsed.scheme in MANIFEST_URL_SCHEMES and bool(parsed.netloc)


def parse_json_object(payload: bytes) -> dict | None:
    try:
        value = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def build_log_only_verdict(reason: str) -> UpdateVerdict:
    return UpdateVerdict(False, ANSWER_LOG, reason)


def build_alarm_verdict(reason: str, code: str) -> UpdateVerdict:
    return UpdateVerdict(False, ANSWER_ALARM, reason, alarm=code)
