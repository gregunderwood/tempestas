"""The anti-drift test.

The agent lives in this repository so that a change to the MQTT contract touches
both sides in one commit. That is only worth anything if something checks - so
this parses `libs/domain/src/lib/hardware/mqtt-contract.ts` and asserts the
Python mirror agrees with it. Change the TypeScript alone and these fail.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tempestas_agent import contract

TS = Path(__file__).resolve().parents[3] / "libs/domain/src/lib/hardware/mqtt-contract.ts"


@pytest.fixture(scope="module")
def source() -> str:
    assert TS.exists(), f"the contract moved: {TS}"
    return TS.read_text()


def test_root_matches(source: str):
    version = re.search(r"MQTT_CONTRACT_VERSION = '([^']+)'", source)
    assert version and version.group(1) == contract.MQTT_CONTRACT_VERSION
    assert f"tempestas/{version.group(1)}" == contract.MQTT_ROOT


def test_every_schema_matches(source: str):
    block = re.search(r"MQTT_SCHEMAS = \{(.*?)\} as const;", source, re.S)
    assert block, "MQTT_SCHEMAS not found in the TypeScript contract"
    ts_schemas = dict(re.findall(r"(\w+):\s*'([^']+)'", block.group(1)))

    assert ts_schemas, "parsed no schemas - the anti-drift test would pass vacuously"
    assert ts_schemas == contract.SCHEMAS


def test_every_topic_builder_matches(source: str):
    block = re.search(r"mqttTopics = \{(.*?)\} as const;", source, re.S)
    assert block, "mqttTopics not found"
    body = block.group(1)

    # Render each TypeScript template literal with the same arguments the Python
    # builder gets, and compare the strings.
    cases = {
        "hello": (contract.topic_hello("n"), {"n": "n"}),
        "status": (contract.topic_status("n"), {"n": "n"}),
        "gpioSet": (contract.topic_gpio_set("n"), {"n": "n"}),
        "gpioSync": (contract.topic_gpio_sync("n"), {"n": "n"}),
        "gpioResult": (contract.topic_gpio_result("n"), {"n": "n"}),
        "heartbeat": (contract.topic_heartbeat("n"), {"n": "n"}),
        "alarm": (contract.topic_alarm("n"), {"n": "n"}),
        "sample": (contract.topic_sample("n", "s"), {"n": "n", "s": "s"}),
        "gpioState": (contract.topic_gpio_state("n", 16), {"n": "n", "pin": "16"}),
    }

    for name, (python_topic, args) in cases.items():
        # `\s*` after the arrow: prettier wraps longer builders onto a second
        # line, and a formatting change must not look like contract drift.
        match = re.search(rf"\b{name}: \([^)]*\) =>\s*`([^`]+)`", body)
        assert match, f"no topic builder for {name} in the TypeScript contract"
        rendered = match.group(1).replace("${MQTT_ROOT}", contract.MQTT_ROOT)
        for key, value in args.items():
            rendered = rendered.replace(f"${{{key}}}", value)
        assert "${" not in rendered, f"unsubstituted placeholder in {name}: {rendered}"
        assert rendered == python_topic, f"{name} drifted"


def test_qos_and_retain_match(source: str):
    block = re.search(r"mqttQos = \{(.*?)\} as const;", source, re.S)
    assert block, "mqttQos not found"
    ts = {
        name: (int(qos), retain == "true")
        for name, qos, retain in re.findall(
            r"(\w+): \{ qos: (\d), retain: (true|false) \}", block.group(1)
        )
    }
    assert ts, "parsed no QoS entries"

    for name, expected in ts.items():
        assert name in contract.QOS, f"the Python contract is missing {name}"
        assert contract.QOS[name] == expected, f"{name} QoS/retain drifted"


def test_commands_are_never_retained():
    """The single most important line in the whole contract."""
    for command in ("gpioSet", "gpioSync"):
        _, retain = contract.QOS[command]
        assert retain is False, f"{command} must never be retained"
