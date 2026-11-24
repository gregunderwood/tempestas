"""Python mirror of mqtt-contract.ts; tests/test_contract_matches_typescript.py holds it there."""

from __future__ import annotations

MQTT_CONTRACT_VERSION = "v1"
MQTT_ROOT = f"tempestas/{MQTT_CONTRACT_VERSION}"

SCHEMAS = {
    "hello": "hello/1",
    "status": "status/1",
    "sample": "sample/1",
    "gpioSet": "gpioSet/1",
    "gpioSync": "gpioSync/1",
    "gpioState": "gpioState/1",
    "gpioResult": "gpioResult/1",
    "heartbeat": "heartbeat/1",
    "alarm": "alarm/1",
    "update": "update/1",
    "updateStatus": "updateStatus/1",
}

SUPPORTED_MAJOR = 1
# What this agent accepts, which may sit behind the TypeScript minor but never ahead of it.
MQTT_CONTRACT_MINOR = 1


def build_node_root(node_id: str) -> str:
    return f"{MQTT_ROOT}/node/{node_id}"


def build_hello_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/hello"


def build_status_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/status"


def build_sample_topic(node_id: str, sensor_id: str) -> str:
    return f"{build_node_root(node_id)}/sensor/{sensor_id}/sample"


def build_gpio_set_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/gpio/set"


def build_gpio_sync_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/gpio/sync"


def build_gpio_state_topic(node_id: str, pin: int) -> str:
    return f"{build_node_root(node_id)}/gpio/state/{pin}"


def build_gpio_result_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/gpio/result"


def build_heartbeat_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/control/heartbeat"


def build_alarm_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/alarm"


def build_update_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/update"


def build_update_status_topic(node_id: str) -> str:
    return f"{build_node_root(node_id)}/update/status"


SERVER_STATUS_TOPIC = f"{MQTT_ROOT}/server/status"

# `retain=False` on the command topics is the most important entry here.
QOS = {
    "hello": (1, False),
    "status": (1, True),
    "sample": (0, False),
    "gpioSet": (1, False),
    "gpioSync": (1, False),
    "gpioState": (1, True),
    "gpioResult": (1, False),
    "heartbeat": (0, False),
    "alarm": (1, False),
    "update": (1, False),
    "updateStatus": (1, False),
    "serverStatus": (1, True),
}


class AlarmCode:
    READBACK_MISMATCH = "READBACK_MISMATCH"
    GPIO_CHIP_LOST = "GPIO_CHIP_LOST"
    GPIO_LINE_BUSY = "GPIO_LINE_BUSY"
    SENSOR_TIMEOUT = "SENSOR_TIMEOUT"
    SENSOR_SELFTEST_FAIL = "SENSOR_SELFTEST_FAIL"
    I2C_NACK = "I2C_NACK"
    DEADMAN_TRIPPED = "DEADMAN_TRIPPED"
    DEADMAN_CLEARED = "DEADMAN_CLEARED"
    COMMAND_EXPIRED = "COMMAND_EXPIRED"
    RETAINED_COMMAND_DROPPED = "RETAINED_COMMAND_DROPPED"
    CONTROLLER_CONFLICT = "CONTROLLER_CONFLICT"
    NO_PROGRESS = "NO_PROGRESS"
    MIN_DWELL_CLAMPED = "MIN_DWELL_CLAMPED"
    SAFE_STATE_ENTERED = "SAFE_STATE_ENTERED"


class UpdateState:
    DOWNLOADING = "downloading"
    VERIFYING = "verifying"
    INSTALLING = "installing"
    RESTARTING = "restarting"
    HEALTHY = "healthy"
    ROLLED_BACK = "rolled-back"
    FAILED = "failed"


def read_schema_major(schema: object) -> int | None:
    if not isinstance(schema, str):
        return None
    parts = schema.split("/")
    if len(parts) != 2 or not parts[1].isdigit():
        return None
    return int(parts[1])
