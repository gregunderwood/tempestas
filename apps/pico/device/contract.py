"""Must match apps/hardware's contract; tests/test_contract_matches_hardware_agent.py holds it there."""

MQTT_CONTRACT_VERSION = "v1"
MQTT_ROOT = "tempestas/" + MQTT_CONTRACT_VERSION

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


def node_root(node_id):
    return MQTT_ROOT + "/node/" + node_id


def topic_hello(node_id):
    return node_root(node_id) + "/hello"


def topic_status(node_id):
    return node_root(node_id) + "/status"


def topic_sample(node_id, sensor_id):
    return node_root(node_id) + "/sensor/" + sensor_id + "/sample"


def topic_gpio_set(node_id):
    return node_root(node_id) + "/gpio/set"


def topic_gpio_sync(node_id):
    return node_root(node_id) + "/gpio/sync"


def topic_gpio_state(node_id, pin):
    return node_root(node_id) + "/gpio/state/" + str(pin)


def topic_gpio_result(node_id):
    return node_root(node_id) + "/gpio/result"


def topic_heartbeat(node_id):
    return node_root(node_id) + "/control/heartbeat"


def topic_alarm(node_id):
    return node_root(node_id) + "/alarm"


SERVER_STATUS_TOPIC = MQTT_ROOT + "/server/status"

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


def read_schema_major(schema):
    if not isinstance(schema, str):
        return None
    parts = schema.split("/")
    if len(parts) != 2 or not parts[1].isdigit():
        return None
    return int(parts[1])
