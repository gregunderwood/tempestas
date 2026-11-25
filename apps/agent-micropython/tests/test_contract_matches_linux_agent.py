"""This contract must equal the Linux agent's, which its own test holds to the TypeScript."""

import importlib.util
import re
from pathlib import Path

import contract as micropython_contract

LINUX_CONTRACT = Path(__file__).resolve().parents[2] / "agent-linux/src/tempestas_agent/contract.py"
TYPESCRIPT_CONTRACT = Path(__file__).resolve().parents[3] / "libs/domain/src/lib/hardware/mqtt-contract.ts"


def load_linux_contract():
    spec = importlib.util.spec_from_file_location("linux_contract", LINUX_CONTRACT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


linux_contract = load_linux_contract()


def test_root_and_schemas_match():
    assert micropython_contract.MQTT_ROOT == linux_contract.MQTT_ROOT
    assert micropython_contract.SCHEMAS == linux_contract.SCHEMAS
    assert micropython_contract.SUPPORTED_MAJOR == linux_contract.SUPPORTED_MAJOR


def test_minor_is_never_ahead_of_the_typescript_contract():
    # Each agent's minor is what it accepts, so the two agents may differ; neither may lead.
    typescript_minor = re.search(r"MQTT_CONTRACT_MINOR = (\d+);", TYPESCRIPT_CONTRACT.read_text())
    assert typescript_minor, "MQTT_CONTRACT_MINOR not found in the TypeScript contract"
    assert int(typescript_minor.group(1)) >= micropython_contract.MQTT_CONTRACT_MINOR, "agent is ahead"


def test_qos_and_retain_match():
    assert micropython_contract.QOS == linux_contract.QOS


def test_every_topic_matches():
    single_node_topics = [
        "build_hello_topic",
        "build_status_topic",
        "build_gpio_set_topic",
        "build_gpio_sync_topic",
        "build_gpio_result_topic",
        "build_heartbeat_topic",
        "build_alarm_topic",
        "build_update_topic",
        "build_update_status_topic",
    ]
    for builder in single_node_topics:
        assert getattr(micropython_contract, builder)("node") == getattr(linux_contract, builder)("node")
    assert micropython_contract.build_sample_topic("node", "air") == linux_contract.build_sample_topic(
        "node", "air"
    )
    assert micropython_contract.build_gpio_state_topic("node", 20) == linux_contract.build_gpio_state_topic(
        "node", 20
    )
    assert micropython_contract.SERVER_STATUS_TOPIC == linux_contract.SERVER_STATUS_TOPIC


def read_public_constants(constant_class):
    return {name: value for name, value in vars(constant_class).items() if not name.startswith("_")}


def test_every_alarm_code_matches():
    assert read_public_constants(micropython_contract.AlarmCode) == read_public_constants(
        linux_contract.AlarmCode
    )


def test_every_update_state_matches():
    assert read_public_constants(micropython_contract.UpdateState) == read_public_constants(
        linux_contract.UpdateState
    )


def test_schema_major_reads_like_the_linux_agent():
    for schema in ["sample/1", "sample/2", "sample", "sample/x", None, 3]:
        assert micropython_contract.read_schema_major(schema) == linux_contract.read_schema_major(schema)


def test_heartbeat_names_the_accepted_version_in_the_same_field():
    assert (
        micropython_contract.HEARTBEAT_ACCEPTED_VERSION_FIELD
        == linux_contract.HEARTBEAT_ACCEPTED_VERSION_FIELD
    )
