"""The Pico's update judge, held to the Linux agent's on the same cases, so the two agents agree."""

import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

import contract
from iso_time import format_iso
from update_guard import ANSWER_ALARM, ANSWER_FAILED_STATUS, ANSWER_LOG, judge_update_command

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent-linux/src"))
from tempestas_agent import update_command as linux_update_command  # noqa: E402

SERVER = "tempestas-server"
NOW_SECONDS = 1795262400
RUNNING_APP = "agent-micropython"
OMITTED = object()


def build_update(**overrides):
    body = {
        "schema": contract.SCHEMAS["update"],
        "node": "braize",
        "ts": format_iso(NOW_SECONDS),
        "id": "update-1",
        "issuedBy": SERVER,
        "expiresAt": format_iso(NOW_SECONDS + 300),
        "app": RUNNING_APP,
        "version": "1.2.1",
        "manifestUrl": "http://elantris:7000/api/agent-releases/agent-micropython/1.2.1/manifest.json",
        "manifestSha256": "a" * 64,
    }
    body.update(overrides)
    return json.dumps({key: value for key, value in body.items() if value is not OMITTED}).encode()


CASES = {
    "a fresh update from the bound controller": (build_update(), False, SERVER),
    "an empty payload": (b"  ", False, SERVER),
    "a retained update": (build_update(), True, SERVER),
    "not JSON": (b"{nope", False, SERVER),
    "another schema major": (build_update(schema="update/2"), False, SERVER),
    "no controller bound yet": (build_update(), False, None),
    "another issuer": (build_update(issuedBy="rogue"), False, SERVER),
    "expired": (build_update(expiresAt=format_iso(NOW_SECONDS - 1)), False, SERVER),
    "no expiresAt": (build_update(expiresAt=OMITTED), False, SERVER),
    "an unparseable expiresAt": (build_update(expiresAt="2026-13-45T25:61:00Z"), False, SERVER),
    "no id": (build_update(id=OMITTED), False, SERVER),
    "an empty id": (build_update(id=""), False, SERVER),
    "another app": (build_update(app="agent-linux"), False, SERVER),
    "an unknown app": (build_update(app="agent-esp-idf"), False, SERVER),
    "an unparseable version": (build_update(version="1.2"), False, SERVER),
    "a version with a suffix": (build_update(version="1.2.1-rc.1"), False, SERVER),
    "another contract major": (build_update(version="2.0.0"), False, SERVER),
    "a non-http manifestUrl": (build_update(manifestUrl="file:///etc/passwd"), False, SERVER),
    "a manifestUrl with no host": (build_update(manifestUrl="http:///manifest.json"), False, SERVER),
    "an uppercase hash": (build_update(manifestSha256="A" * 64), False, SERVER),
    "a short hash": (build_update(manifestSha256="a" * 63), False, SERVER),
}


def judge_on_the_pico(payload, is_retained, bound_controller):
    return judge_update_command(payload, is_retained, bound_controller, NOW_SECONDS, RUNNING_APP)


def judge_on_linux(payload, is_retained, bound_controller):
    return linux_update_command.judge_update_command(
        payload,
        is_retained=is_retained,
        bound_controller=bound_controller,
        running_app=RUNNING_APP,
        now=datetime.fromtimestamp(NOW_SECONDS, UTC),
    )


@pytest.mark.parametrize("case", list(CASES))
def test_judges_each_case_as_the_linux_agent_does(case):
    pico = judge_on_the_pico(*CASES[case])
    linux = judge_on_linux(*CASES[case])

    assert (pico.is_accepted, pico.answer, pico.alarm_code) == (linux.is_accepted, linux.answer, linux.alarm)


def test_answers_with_the_same_kinds_as_the_linux_agent():
    assert (ANSWER_LOG, ANSWER_ALARM, ANSWER_FAILED_STATUS) == (
        linux_update_command.ANSWER_LOG,
        linux_update_command.ANSWER_ALARM,
        linux_update_command.ANSWER_FAILED_STATUS,
    )


def test_refuses_quietly_until_ntp_has_set_the_clock():
    verdict = judge_update_command(build_update(), False, SERVER, None, RUNNING_APP)

    assert (verdict.is_accepted, verdict.answer) == (False, ANSWER_LOG)
    assert "clock" in verdict.reason


def test_a_failed_status_names_the_command_it_answers():
    verdict = judge_on_the_pico(build_update(app="agent-linux"), False, SERVER)

    assert verdict.command_id == "update-1"
    assert verdict.reason == "update is for agent-linux, this node runs agent-micropython"
