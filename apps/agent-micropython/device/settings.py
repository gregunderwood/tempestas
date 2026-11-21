"""This node's configuration. Credentials are in credentials.py, which is never committed."""

NODE_ID = "braize"
NODE_KIND = "pico"
AGENT_VERSION = "0.1.0"

BROKER_HOST = "192.168.2.70"
BROKER_PORT = 1883
KEEPALIVE_SECONDS = 60

# Hold, then on: both loads hang off NC contacts, so a lost controller ends in heat.
DEADMAN_SECONDS = 600
SAMPLE_INTERVAL_SECONDS = 10

ONE_WIRE_PIN = 16

# Pinned by ROM, in the kernel's form; read with one probe on the bus at a time.
PROBES = {
    "28-3ce1d4436ee8": "air",
}

HEATER_PIN = 20
HEAT_TAPE_PIN = 18
RELAY_LINES = (HEATER_PIN, HEAT_TAPE_PIN)

# 1 = pin released = relay de-energised = NC closed = load ON.
FAILSAFE_LEVELS = {
    HEATER_PIN: 1,
    HEAT_TAPE_PIN: 1,
}
