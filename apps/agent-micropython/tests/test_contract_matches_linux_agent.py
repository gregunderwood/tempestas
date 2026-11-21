"""This contract must equal the Linux agent's, which its own test holds to the TypeScript."""

import importlib.util
from pathlib import Path

import contract as micropython_contract

LINUX_CONTRACT = Path(__file__).resolve().parents[2] / "agent-linux/src/tempestas_agent/contract.py"


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


def test_qos_and_retain_match():
    assert micropython_contract.QOS == linux_contract.QOS


def test_every_topic_matches():
    single_node_topics = [
        "topic_hello",
        "topic_status",
        "topic_gpio_set",
        "topic_gpio_sync",
        "topic_gpio_result",
        "topic_heartbeat",
        "topic_alarm",
    ]
    for builder in single_node_topics:
        assert getattr(micropython_contract, builder)("node") == getattr(linux_contract, builder)("node")
    assert micropython_contract.topic_sample("node", "air") == linux_contract.topic_sample("node", "air")
    assert micropython_contract.topic_gpio_state("node", 20) == linux_contract.topic_gpio_state("node", 20)
    assert micropython_contract.SERVER_STATUS_TOPIC == linux_contract.SERVER_STATUS_TOPIC


def test_every_alarm_code_matches():
    def public_codes(alarm_class):
        return {name: value for name, value in vars(alarm_class).items() if not name.startswith("_")}

    assert public_codes(micropython_contract.AlarmCode) == public_codes(linux_contract.AlarmCode)


def test_schema_major_reads_like_the_hardware_agent():
    for schema in ["sample/1", "sample/2", "sample", "sample/x", None, 3]:
        assert micropython_contract.read_schema_major(schema) == linux_contract.schema_major(schema)
