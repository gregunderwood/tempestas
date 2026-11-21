"""The Pico's contract must equal the Pi agent's, which its own test holds to the TypeScript."""

import importlib.util
from pathlib import Path

import contract as pico_contract

HARDWARE_CONTRACT = Path(__file__).resolve().parents[2] / "hardware/src/tempestas_agent/contract.py"


def load_hardware_contract():
    spec = importlib.util.spec_from_file_location("hardware_contract", HARDWARE_CONTRACT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hardware_contract = load_hardware_contract()


def test_root_and_schemas_match():
    assert pico_contract.MQTT_ROOT == hardware_contract.MQTT_ROOT
    assert pico_contract.SCHEMAS == hardware_contract.SCHEMAS
    assert pico_contract.SUPPORTED_MAJOR == hardware_contract.SUPPORTED_MAJOR


def test_qos_and_retain_match():
    assert pico_contract.QOS == hardware_contract.QOS


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
        assert getattr(pico_contract, builder)("node") == getattr(hardware_contract, builder)("node")
    assert pico_contract.topic_sample("node", "air") == hardware_contract.topic_sample("node", "air")
    assert pico_contract.topic_gpio_state("node", 20) == hardware_contract.topic_gpio_state("node", 20)
    assert pico_contract.SERVER_STATUS_TOPIC == hardware_contract.SERVER_STATUS_TOPIC


def test_every_alarm_code_matches():
    def public_codes(alarm_class):
        return {name: value for name, value in vars(alarm_class).items() if not name.startswith("_")}

    assert public_codes(pico_contract.AlarmCode) == public_codes(hardware_contract.AlarmCode)


def test_schema_major_reads_like_the_hardware_agent():
    for schema in ["sample/1", "sample/2", "sample", "sample/x", None, 3]:
        assert pico_contract.read_schema_major(schema) == hardware_contract.schema_major(schema)
