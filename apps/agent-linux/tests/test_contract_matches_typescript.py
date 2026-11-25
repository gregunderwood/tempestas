"""The anti-drift test: parse mqtt-contract.ts and assert the Python mirror agrees with it."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tempestas_agent import contract

TYPESCRIPT_CONTRACT = (
    Path(__file__).resolve().parents[3] / "libs/domain/src/lib/hardware/mqtt-contract.ts"
)


@pytest.fixture(scope="module")
def source() -> str:
    assert TYPESCRIPT_CONTRACT.exists(), f"the contract moved: {TYPESCRIPT_CONTRACT}"
    return TYPESCRIPT_CONTRACT.read_text()


def test_root_matches(source: str):
    version = re.search(r"MQTT_CONTRACT_VERSION = '([^']+)'", source)
    assert version and version.group(1) == contract.MQTT_CONTRACT_VERSION
    assert f"tempestas/{version.group(1)}" == contract.MQTT_ROOT


def test_contract_version_matches(source: str):
    major = re.search(r"MQTT_CONTRACT_MAJOR = (\d+);", source)
    minor = re.search(r"MQTT_CONTRACT_MINOR = (\d+);", source)
    assert major and int(major.group(1)) == contract.SUPPORTED_MAJOR
    assert minor, "MQTT_CONTRACT_MINOR not found in the TypeScript contract"
    typescript_minor = int(minor.group(1))
    assert typescript_minor >= contract.MQTT_CONTRACT_MINOR, "agent is ahead of the contract"


def test_every_schema_matches(source: str):
    block = re.search(r"MQTT_SCHEMAS = \{(.*?)\} as const;", source, re.S)
    assert block, "MQTT_SCHEMAS not found in the TypeScript contract"
    typescript_schemas = dict(re.findall(r"(\w+):\s*'([^']+)'", block.group(1)))

    assert typescript_schemas, "parsed no schemas - the anti-drift test would pass vacuously"
    assert typescript_schemas == contract.SCHEMAS


def test_every_topic_builder_matches(source: str):
    block = re.search(r"mqttTopics = \{(.*?)\} as const;", source, re.S)
    assert block, "mqttTopics not found"
    body = block.group(1)

    # Each TypeScript template literal is rendered with the arguments the Python builder gets.
    cases = {
        "hello": (contract.build_hello_topic("n"), {"n": "n"}),
        "status": (contract.build_status_topic("n"), {"n": "n"}),
        "gpioSet": (contract.build_gpio_set_topic("n"), {"n": "n"}),
        "gpioSync": (contract.build_gpio_sync_topic("n"), {"n": "n"}),
        "gpioResult": (contract.build_gpio_result_topic("n"), {"n": "n"}),
        "heartbeat": (contract.build_heartbeat_topic("n"), {"n": "n"}),
        "alarm": (contract.build_alarm_topic("n"), {"n": "n"}),
        "update": (contract.build_update_topic("n"), {"n": "n"}),
        "updateStatus": (contract.build_update_status_topic("n"), {"n": "n"}),
        "sample": (contract.build_sample_topic("n", "s"), {"n": "n", "s": "s"}),
        "gpioState": (contract.build_gpio_state_topic("n", 16), {"n": "n", "pin": "16"}),
    }

    for name, (python_topic, placeholders) in cases.items():
        # `\s*` after the arrow: prettier wrapping a longer builder is formatting, not drift.
        match = re.search(rf"\b{name}: \([^)]*\) =>\s*`([^`]+)`", body)
        assert match, f"no topic builder for {name} in the TypeScript contract"
        rendered = match.group(1).replace("${MQTT_ROOT}", contract.MQTT_ROOT)
        for placeholder, value in placeholders.items():
            rendered = rendered.replace(f"${{{placeholder}}}", value)
        assert "${" not in rendered, f"unsubstituted placeholder in {name}: {rendered}"
        assert rendered == python_topic, f"{name} drifted"


def test_qos_and_retain_match(source: str):
    block = re.search(r"mqttQos = \{(.*?)\} as const;", source, re.S)
    assert block, "mqttQos not found"
    typescript_qos = {
        name: (int(qos), retain == "true")
        for name, qos, retain in re.findall(
            r"(\w+): \{ qos: (\d), retain: (true|false) \}", block.group(1)
        )
    }
    assert typescript_qos, "parsed no QoS entries"

    for name, expected in typescript_qos.items():
        assert name in contract.QOS, f"the Python contract is missing {name}"
        assert contract.QOS[name] == expected, f"{name} QoS/retain drifted"


def test_every_update_state_matches(source: str):
    block = re.search(r"export enum UpdateState \{(.*?)\}", source, re.S)
    assert block, "UpdateState not found in the TypeScript contract"
    typescript_states = set(re.findall(r"=\s*'([^']+)'", block.group(1)))

    assert typescript_states, "parsed no update states"
    python_states = {
        value for name, value in vars(contract.UpdateState).items() if not name.startswith("_")
    }
    assert python_states == typescript_states


def test_commands_are_never_retained():
    for command in ("gpioSet", "gpioSync", "update"):
        _, retain = contract.QOS[command]
        assert retain is False, f"{command} must never be retained"


def test_heartbeat_names_the_accepted_version_in_the_same_field(source: str):
    block = re.search(r"interface HeartbeatPayload extends MqttEnvelope \{(.*?)\n\}", source, re.S)
    assert block, "HeartbeatPayload not found in the TypeScript contract"
    typescript_fields = re.findall(r"^\s*(\w+)\??:", block.group(1), re.M)

    assert contract.HEARTBEAT_ACCEPTED_VERSION_FIELD in typescript_fields
