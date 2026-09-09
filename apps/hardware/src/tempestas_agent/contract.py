"""The MQTT contract, Python side.

This mirrors `libs/domain/src/lib/hardware/mqtt-contract.ts`. The mirroring is
checked by `tests/test_contract_matches_typescript.py`, which parses the
TypeScript rather than trusting anyone to keep two files in step by hand.

The safety rules this file carries are not style preferences:

  * COMMANDS ARE NEVER RETAINED, and the retain flag alone does not enforce it -
    MQTT only sets that flag when delivery is caused by a NEW SUBSCRIPTION, so a
    retained command published while we are already connected looks completely
    ordinary. The defence that works is ownership: refuse any command whose
    `issuedBy` is not the controller we are bound to.
  * An EMPTY command payload is how a retained command is cleared. Ignore it;
    never parse it, never react to it.
  * Every command carries `expiresAt` and must be refused when late.
  * STALE IS NOT OFF. A line we cannot read back is `known: false`, not 0.
"""

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
}

SUPPORTED_MAJOR = 1


def node_root(node_id: str) -> str:
    return f"{MQTT_ROOT}/node/{node_id}"


def topic_hello(node_id: str) -> str:
    return f"{node_root(node_id)}/hello"


def topic_status(node_id: str) -> str:
    return f"{node_root(node_id)}/status"


def topic_sample(node_id: str, sensor_id: str) -> str:
    return f"{node_root(node_id)}/sensor/{sensor_id}/sample"


def topic_gpio_set(node_id: str) -> str:
    return f"{node_root(node_id)}/gpio/set"


def topic_gpio_sync(node_id: str) -> str:
    return f"{node_root(node_id)}/gpio/sync"


def topic_gpio_state(node_id: str, pin: int) -> str:
    return f"{node_root(node_id)}/gpio/state/{pin}"


def topic_gpio_result(node_id: str) -> str:
    return f"{node_root(node_id)}/gpio/result"


def topic_heartbeat(node_id: str) -> str:
    return f"{node_root(node_id)}/control/heartbeat"


def topic_alarm(node_id: str) -> str:
    return f"{node_root(node_id)}/alarm"


SERVER_STATUS_TOPIC = f"{MQTT_ROOT}/server/status"

# QoS and retain per topic, encoded so they cannot drift into folklore.
# `retain=False` on the command topics is the single most important entry here.
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


def schema_major(schema: object) -> int | None:
    """`"sample/2"` -> 2. None when it is not a schema string at all."""
    if not isinstance(schema, str):
        return None
    parts = schema.split("/")
    if len(parts) != 2 or not parts[1].isdigit():
        return None
    return int(parts[1])
