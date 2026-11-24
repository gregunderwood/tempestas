"""The update judge, on the cases of update-command.spec.ts, so the node and the reference agree."""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from tempestas_agent import contract
from tempestas_agent.update_command import (
    ANSWER_ALARM,
    ANSWER_FAILED_STATUS,
    ANSWER_LOG,
    judge_update_command,
)

SERVER = "tempestas-server"
NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=UTC)
OMITTED = object()


def build_update(**overrides) -> bytes:
    body = {
        "schema": contract.SCHEMAS["update"],
        "node": "patji",
        "ts": NOW.isoformat(),
        "id": "update-1",
        "issuedBy": SERVER,
        "expiresAt": "2026-11-21T12:05:00Z",
        "app": "agent-linux",
        "version": "1.1.4",
        "manifestUrl": "http://elantris.local:7000/api/bundles/agent-linux/1.1.4/manifest.json",
        "manifestSha256": "a" * 64,
    }
    body.update(overrides)
    return json.dumps({key: value for key, value in body.items() if value is not OMITTED}).encode()


def judge(payload: bytes, *, retained: bool = False, bound: str | None = SERVER):
    return judge_update_command(
        payload, retained=retained, bound_controller=bound, running_app="agent-linux", now=NOW
    )


def test_accepts_a_fresh_update_from_the_bound_controller_for_this_app():
    verdict = judge(build_update())
    assert verdict.is_accepted is True
    assert verdict.command["version"] == "1.1.4"


def test_ignores_an_empty_payload_without_alarming_since_that_is_a_retained_clear():
    verdict = judge(b"  ")
    assert (verdict.is_accepted, verdict.answer) == (False, ANSWER_LOG)


def test_logs_an_expiry_shaped_like_a_date_that_is_not_one():
    verdict = judge(build_update(expiresAt="2026-13-45T25:61:00Z"))
    assert (verdict.is_accepted, verdict.answer) == (False, ANSWER_LOG)


def test_drops_a_retained_update_and_alarms():
    verdict = judge(build_update(), retained=True)
    assert verdict.answer == ANSWER_ALARM
    assert verdict.alarm == contract.AlarmCode.RETAINED_COMMAND_DROPPED


def test_refuses_a_foreign_issuer_and_alarms_a_controller_conflict():
    verdict = judge(build_update(issuedBy="laptop"))
    assert verdict.alarm == contract.AlarmCode.CONTROLLER_CONFLICT


def test_only_logs_any_update_before_a_controller_is_bound_unlike_gpio_set():
    verdict = judge(build_update(), bound=None)
    assert (verdict.answer, verdict.reason) == (ANSWER_LOG, "no controller is bound yet")


def test_refuses_an_expired_update_and_alarms():
    verdict = judge(build_update(expiresAt="2026-11-21T11:59:59Z"))
    assert verdict.alarm == contract.AlarmCode.COMMAND_EXPIRED


def test_judges_the_retain_flag_before_ownership_and_ownership_before_expiry():
    foreign_and_expired = build_update(issuedBy="laptop", expiresAt="2026-11-21T11:00:00Z")
    retained = judge(foreign_and_expired, retained=True)
    assert retained.alarm == contract.AlarmCode.RETAINED_COMMAND_DROPPED
    assert judge(foreign_and_expired).alarm == contract.AlarmCode.CONTROLLER_CONFLICT


@pytest.mark.parametrize(
    "payload",
    [
        b"{not json",
        b"[]",
        build_update(schema="update/2"),
        build_update(expiresAt=OMITTED),
        build_update(expiresAt="soon"),
        build_update(expiresAt="2027"),
        build_update(expiresAt="2027-01-01"),
        build_update(expiresAt="Nov 21 2027"),
        build_update(expiresAt="2027-01-01T00:00:00"),
        build_update(id=""),
    ],
    ids=[
        "not JSON",
        "a JSON array",
        "another schema major",
        "no expiresAt",
        "an unparseable expiresAt",
        "a bare year",
        "a date with no time",
        "an English date",
        "an instant with no offset",
        "no id",
    ],
)
def test_only_logs_an_update_that_is_malformed(payload: bytes):
    verdict = judge(payload)
    assert (verdict.is_accepted, verdict.answer) == (False, ANSWER_LOG)


@pytest.mark.parametrize(
    ("overrides", "reason_fragment"),
    [
        ({"app": "agent-micropython"}, "this node runs agent-linux"),
        ({"app": "agent-zephyr"}, "unknown app"),
        ({"version": "2.0.0"}, "contract major 2"),
        ({"version": "latest"}, "unparseable version"),
        ({"manifestUrl": "file:///etc/passwd"}, "not an http(s) URL"),
        ({"manifestUrl": "elantris"}, "not an http(s) URL"),
        ({"manifestSha256": "A" * 64}, "64 lowercase hex"),
        ({"manifestSha256": "abc"}, "64 lowercase hex"),
        ({"manifestSha256": "a" * 64 + "\n"}, "64 lowercase hex"),
    ],
    ids=[
        "another app",
        "an unknown app",
        "another contract major",
        "an unparseable version",
        "a manifest that is not http",
        "a malformed manifest URL",
        "an uppercase sha256",
        "a short sha256",
        "a sha256 with a trailing newline",
    ],
)
def test_reports_a_bad_target_back_to_the_server_as_a_failed_update(overrides, reason_fragment):
    verdict = judge(build_update(**overrides))
    assert (verdict.answer, verdict.command_id) == (ANSWER_FAILED_STATUS, "update-1")
    assert reason_fragment in verdict.reason


@pytest.mark.parametrize(
    "expires_at",
    ["2026-11-21T12:05:00Z", "2026-11-21T12:05:00.250Z", "2026-11-21T07:05:00-05:00"],
)
def test_accepts_an_iso_8601_expires_at(expires_at: str):
    assert judge(build_update(expiresAt=expires_at)).is_accepted is True


def test_accepts_a_development_build_of_the_same_contract_major():
    assert judge(build_update(version="1.1.4-dev+ecdbbe7.dirty")).is_accepted is True
