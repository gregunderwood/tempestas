"""Hardware and time are passed in, so the tests run this exactly as the Pico does."""

import json

import contract
from command_guard import judge_command, parse_json_object
from iso_time import format_iso, is_clock_set

MILLISECONDS_PER_SECOND = 1000
ONLINE_STATE = "online"
SERVER_OFFLINE_STATE = "offline"
NOT_MEASURED = "NOT_MEASURED"
CRITICAL_SEVERITY = "critical"
INFO_SEVERITY = "info"
PROBE_KIND = "ds18b20"
TEMPERATURE_METRIC = "temperature"
TEMPERATURE_DECIMAL_PLACES = 2
KNOWN_LEVELS = (0, 1)


class NodeAgent:
    def __init__(self, settings, publisher, relay_lines, probes, clock, log, boot_id):
        self.settings = settings
        self.publisher = publisher
        self.relay_lines = relay_lines
        self.probes = probes
        self.clock = clock
        self.log = log
        self.boot_id = boot_id
        self.node_id = settings.NODE_ID
        self.sequence_number = 0
        self.bound_controller = None
        self.last_heartbeat_ticks = None
        self.is_deadman_tripped = False
        self.has_unpublished_states = False

    def announce(self):
        self.send(
            "status", contract.build_status_topic(self.node_id), self.build_status_payload(ONLINE_STATE)
        )
        self.send("hello", contract.build_hello_topic(self.node_id), self.build_hello_payload())
        self.publish_gpio_states(self.relay_lines.lines)

    def list_subscriptions(self):
        node_id = self.node_id
        return [
            (contract.build_gpio_set_topic(node_id), 1),
            (contract.build_gpio_sync_topic(node_id), 1),
            (contract.build_heartbeat_topic(node_id), 0),
            (contract.SERVER_STATUS_TOPIC, 1),
        ]

    def on_message(self, topic, payload, is_retained):
        node_id = self.node_id
        if topic == contract.build_heartbeat_topic(node_id):
            self.on_heartbeat(payload)
        elif topic == contract.SERVER_STATUS_TOPIC:
            self.on_server_status(payload)
        elif topic == contract.build_gpio_set_topic(node_id):
            self.on_command(payload, is_retained)

    def on_command(self, payload, is_retained):
        verdict = judge_command(payload, is_retained, self.bound_controller, self.read_set_clock())
        if not verdict.is_accepted:
            self.report_refusal(verdict)
            return
        command = json.loads(payload)
        line_results = [self.apply_line(line) for line in command["lines"]]
        self.send(
            "gpioResult",
            contract.build_gpio_result_topic(self.node_id),
            self.build_result_payload(command["id"], line_results),
        )
        self.publish_gpio_states(self.select_managed_pins(line_results))

    def select_managed_pins(self, line_results):
        return [
            line_result["pin"] for line_result in line_results if line_result["pin"] in self.relay_lines.lines
        ]

    def apply_line(self, line):
        pin = line["pin"]
        requested = line["level"]
        try:
            self.relay_lines.write(pin, requested)
            readback = self.relay_lines.read_level(pin)
        except Exception as error:
            self.log("pin %d could not be driven: %s" % (pin, error))
            return {"pin": pin, "requested": requested, "readback": None, "ok": False, "error": str(error)}
        return {"pin": pin, "requested": requested, "readback": readback, "ok": readback == requested}

    def report_refusal(self, verdict):
        if verdict.alarm_code is None:
            self.log("ignored a command: %s" % verdict.reason)
            return
        self.log("refused a command: %s" % verdict.reason)
        self.publish_alarm(verdict.alarm_code, CRITICAL_SEVERITY, verdict.reason)

    def on_heartbeat(self, payload):
        heartbeat = parse_json_object(payload)
        if heartbeat is None:
            return
        controller = heartbeat.get("controller")
        if isinstance(controller, str) and controller != self.bound_controller:
            self.log("bound to controller %s (epoch %s)" % (controller, heartbeat.get("epoch")))
            self.bound_controller = controller
        self.last_heartbeat_ticks = self.clock.ticks()
        if self.is_deadman_tripped:
            self.is_deadman_tripped = False
            self.publish_alarm(contract.AlarmCode.DEADMAN_CLEARED, INFO_SEVERITY, "heartbeats resumed")

    def on_server_status(self, payload):
        if is_server_offline(parse_json_object(payload)):
            self.log("the server reported itself OFFLINE - entering failsafe now")
            self.enter_failsafe(contract.AlarmCode.SAFE_STATE_ENTERED, "server published offline")

    def check_deadman(self):
        if self.last_heartbeat_ticks is None or self.is_deadman_tripped:
            return False
        if not self.is_heartbeat_overdue():
            return False
        self.is_deadman_tripped = True
        self.log("no heartbeat for %ds - entering failsafe" % self.settings.DEADMAN_SECONDS)
        self.enter_failsafe(
            contract.AlarmCode.DEADMAN_TRIPPED,
            "no controller heartbeat for %ds" % self.settings.DEADMAN_SECONDS,
        )
        return True

    def is_heartbeat_overdue(self):
        silent_milliseconds = self.clock.elapsed_since(self.last_heartbeat_ticks)
        return silent_milliseconds >= self.settings.DEADMAN_SECONDS * MILLISECONDS_PER_SECOND

    def enter_failsafe(self, alarm_code, message):
        # Hardware first, then retained state, then the alarm, so whoever reacts sees the real lines.
        self.relay_lines.failsafe()
        self.publish_gpio_states(self.relay_lines.lines)
        self.publish_alarm(alarm_code, CRITICAL_SEVERITY, message)

    def publish_readings(self):
        for reading in self.probes.read_all():
            topic = contract.build_sample_topic(self.node_id, reading.sensor_id)
            self.send("sample", topic, self.build_sample_payload(reading))

    def publish_gpio_states(self, pins):
        if self.read_set_clock() is None:
            # A retained state dated 1970 would lose to the server's own row when it is replayed.
            self.has_unpublished_states = True
            return
        for pin in pins:
            self.send(
                "gpioState",
                contract.build_gpio_state_topic(self.node_id, pin),
                self.build_gpio_state_payload(pin),
            )

    def on_clock_set(self):
        if not self.has_unpublished_states:
            return
        self.has_unpublished_states = False
        self.publish_gpio_states(self.relay_lines.lines)

    def publish_alarm(self, alarm_code, severity, message):
        self.send(
            "alarm",
            contract.build_alarm_topic(self.node_id),
            self.build_alarm_payload(alarm_code, severity, message),
        )

    def send(self, message_name, topic, payload):
        quality_of_service, is_retained = contract.QOS[message_name]
        should_hold_while_offline = message_name in contract.HELD_WHILE_OFFLINE
        self.publisher.publish(
            topic, json.dumps(payload), is_retained, quality_of_service, should_hold_while_offline
        )

    def describe_capabilities(self):
        sample_interval_milliseconds = int(self.settings.SAMPLE_INTERVAL_SECONDS * MILLISECONDS_PER_SECOND)
        return {
            "contractVersion": contract.SUPPORTED_MAJOR,
            "sensors": [
                {
                    "sensorId": sensor_id,
                    "kind": PROBE_KIND,
                    "metrics": [TEMPERATURE_METRIC],
                    "sampleIntervalMs": sample_interval_milliseconds,
                }
                for sensor_id in self.probes.sensor_ids()
            ],
            "gpio": {"pins": list(self.relay_lines.lines), "supportsReadback": True},
            "hasRtc": False,
        }

    def build_envelope(self, schema_name):
        return {"schema": contract.SCHEMAS[schema_name], "node": self.node_id, "ts": self.now_iso()}

    def build_hello_payload(self):
        payload = self.build_envelope("hello")
        payload["kind"] = self.settings.NODE_KIND
        payload["agentVersion"] = self.settings.AGENT_VERSION
        payload["bootId"] = self.boot_id
        payload["capabilities"] = self.describe_capabilities()
        return payload

    def build_status_payload(self, state):
        payload = self.build_envelope("status")
        payload["state"] = state
        return payload

    def build_sample_payload(self, reading):
        self.sequence_number += 1
        payload = self.build_envelope("sample")
        payload["seq"] = self.sequence_number
        payload["sensor"] = reading.sensor_id
        payload["measurements"] = {
            "co2Ppm": build_unmeasured_metric("ppm"),
            "tempC": {
                "value": round(reading.temperature_celsius, TEMPERATURE_DECIMAL_PLACES),
                "valid": True,
                "unit": "C",
            },
            "humidityPct": build_unmeasured_metric("%"),
        }
        payload["sensorStatus"] = {"ok": True, "consecutiveFailures": 0, "lastSuccessTs": self.now_iso()}
        return payload

    def build_gpio_state_payload(self, pin):
        level = self.relay_lines.read_level(pin)
        payload = self.build_envelope("gpioState")
        payload["pin"] = pin
        payload["level"] = level
        payload["known"] = level in KNOWN_LEVELS
        return payload

    def build_result_payload(self, command_id, line_results):
        payload = self.build_envelope("gpioResult")
        payload["id"] = command_id
        payload["ok"] = all(line_result["ok"] for line_result in line_results)
        payload["lines"] = line_results
        return payload

    def build_alarm_payload(self, alarm_code, severity, message):
        payload = self.build_envelope("alarm")
        payload["code"] = alarm_code
        payload["severity"] = severity
        payload["message"] = message
        return payload

    def now_iso(self):
        return format_iso(self.clock.epoch_seconds())

    def read_set_clock(self):
        epoch_seconds = self.clock.epoch_seconds()
        return epoch_seconds if is_clock_set(epoch_seconds) else None


def is_server_offline(server_status):
    return server_status is not None and server_status.get("state") == SERVER_OFFLINE_STATE


def build_unmeasured_metric(unit):
    return {"value": None, "valid": False, "unit": unit, "reason": NOT_MEASURED}
