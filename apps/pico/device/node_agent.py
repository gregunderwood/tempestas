"""The agent: announce, sample, obey carefully, fail safe.

Hardware and time are injected, so everything here runs under CPython in the tests exactly as
it runs on the Pico. The behaviour mirrors apps/hardware's Agent; docs/Infrastructure/MQTT
Contract.md lists the obligations.
"""

import json

import contract
from command_guard import judge_command, parse_json_object
from iso_time import format_iso, is_clock_set

MILLISECONDS_PER_SECOND = 1000
SERVER_OFFLINE_STATE = "offline"
NOT_MEASURED = "NOT_MEASURED"


class NodeAgent:
    def __init__(self, settings, publisher, relay_lines, probes, clock, log, boot_id):
        self.settings = settings
        self.publisher = publisher
        self.relay_lines = relay_lines
        self.probes = probes
        self.clock = clock
        self.log = log
        self.boot_id = boot_id
        self.sequence_number = 0
        self.bound_controller = None
        self.last_heartbeat_ticks = None
        self.is_deadman_tripped = False

    def announce(self):
        """On every connect: online, hello, then the lines as they are."""
        self.send("status", contract.topic_status(self.node_id()), self.status_payload("online"))
        self.send("hello", contract.topic_hello(self.node_id()), self.hello_payload())
        self.publish_gpio_states(self.relay_lines.lines)

    def subscriptions(self):
        node_id = self.node_id()
        return [
            (contract.topic_gpio_set(node_id), 1),
            (contract.topic_gpio_sync(node_id), 1),
            (contract.topic_heartbeat(node_id), 0),
            (contract.SERVER_STATUS_TOPIC, 1),
        ]

    def on_message(self, topic, payload, is_retained):
        node_id = self.node_id()
        if topic == contract.topic_heartbeat(node_id):
            self.on_heartbeat(payload)
        elif topic == contract.SERVER_STATUS_TOPIC:
            self.on_server_status(payload)
        elif topic == contract.topic_gpio_set(node_id):
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
            contract.topic_gpio_result(self.node_id()),
            self.result_payload(command["id"], line_results),
        )
        self.publish_gpio_states(self.managed_pins_of(line_results))

    def managed_pins_of(self, line_results):
        return [
            line_result["pin"] for line_result in line_results if line_result["pin"] in self.relay_lines.lines
        ]

    def apply_line(self, line):
        pin = line["pin"]
        requested = line["level"]
        try:
            self.relay_lines.write(pin, requested)
            readback = self.relay_lines.level(pin)
        except Exception as error:
            self.log("pin %d could not be driven: %s" % (pin, error))
            return {"pin": pin, "requested": requested, "readback": None, "ok": False, "error": str(error)}
        return {"pin": pin, "requested": requested, "readback": readback, "ok": readback == requested}

    def report_refusal(self, verdict):
        if verdict.alarm_code is None:
            self.log("ignored a command: %s" % verdict.reason)
            return
        self.log("refused a command: %s" % verdict.reason)
        self.publish_alarm(verdict.alarm_code, "critical", verdict.reason)

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
            self.publish_alarm(contract.AlarmCode.DEADMAN_CLEARED, "info", "heartbeats resumed")

    def on_server_status(self, payload):
        server_status = parse_json_object(payload)
        if server_status is not None and server_status.get("state") == SERVER_OFFLINE_STATE:
            self.log("the server reported itself OFFLINE - entering failsafe now")
            self.enter_failsafe(contract.AlarmCode.SAFE_STATE_ENTERED, "server published offline")

    def check_deadman(self):
        if self.last_heartbeat_ticks is None or self.is_deadman_tripped:
            return False
        silent_milliseconds = self.clock.elapsed_since(self.last_heartbeat_ticks)
        if silent_milliseconds < self.settings.DEADMAN_SECONDS * MILLISECONDS_PER_SECOND:
            return False
        self.is_deadman_tripped = True
        self.log("no heartbeat for %ds - entering failsafe" % self.settings.DEADMAN_SECONDS)
        self.enter_failsafe(
            contract.AlarmCode.DEADMAN_TRIPPED,
            "no controller heartbeat for %ds" % self.settings.DEADMAN_SECONDS,
        )
        return True

    def enter_failsafe(self, alarm_code, message):
        # Hardware first, then retained state, then the alarm, so whoever reacts sees the real lines.
        self.relay_lines.failsafe()
        self.publish_gpio_states(self.relay_lines.lines)
        self.publish_alarm(alarm_code, "critical", message)

    def publish_readings(self):
        for reading in self.probes.read_all():
            topic = contract.topic_sample(self.node_id(), reading.sensor_id)
            self.send("sample", topic, self.sample_payload(reading))

    def publish_gpio_states(self, pins):
        for pin in pins:
            self.send(
                "gpioState", contract.topic_gpio_state(self.node_id(), pin), self.gpio_state_payload(pin)
            )

    def publish_alarm(self, alarm_code, severity, message):
        self.send(
            "alarm", contract.topic_alarm(self.node_id()), self.alarm_payload(alarm_code, severity, message)
        )

    def send(self, qos_name, topic, payload):
        quality_of_service, is_retained = contract.QOS[qos_name]
        self.publisher.publish(topic, json.dumps(payload), is_retained, quality_of_service)

    def capabilities(self):
        sample_interval_milliseconds = int(self.settings.SAMPLE_INTERVAL_SECONDS * MILLISECONDS_PER_SECOND)
        return {
            "contractVersion": contract.SUPPORTED_MAJOR,
            "sensors": [
                {
                    "sensorId": sensor_id,
                    "kind": "ds18b20",
                    "metrics": ["temperature"],
                    "sampleIntervalMs": sample_interval_milliseconds,
                }
                for sensor_id in self.probes.sensor_ids()
            ],
            "gpio": {"pins": list(self.relay_lines.lines), "supportsReadback": True},
            "hasRtc": False,
        }

    def envelope(self, schema_name):
        return {"schema": contract.SCHEMAS[schema_name], "node": self.node_id(), "ts": self.now_iso()}

    def hello_payload(self):
        payload = self.envelope("hello")
        payload["kind"] = self.settings.NODE_KIND
        payload["agentVersion"] = self.settings.AGENT_VERSION
        payload["bootId"] = self.boot_id
        payload["capabilities"] = self.capabilities()
        return payload

    def status_payload(self, state):
        payload = self.envelope("status")
        payload["state"] = state
        return payload

    def sample_payload(self, reading):
        self.sequence_number += 1
        payload = self.envelope("sample")
        payload["seq"] = self.sequence_number
        payload["sensor"] = reading.sensor_id
        payload["measurements"] = {
            "co2Ppm": not_measured("ppm"),
            "tempC": {"value": round(reading.temperature_celsius, 2), "valid": True, "unit": "C"},
            "humidityPct": not_measured("%"),
        }
        payload["sensorStatus"] = {"ok": True, "consecutiveFailures": 0, "lastSuccessTs": self.now_iso()}
        return payload

    def gpio_state_payload(self, pin):
        level = self.relay_lines.level(pin)
        payload = self.envelope("gpioState")
        payload["pin"] = pin
        payload["level"] = level
        payload["known"] = level in (0, 1)
        return payload

    def result_payload(self, command_id, line_results):
        payload = self.envelope("gpioResult")
        payload["id"] = command_id
        payload["ok"] = all(line_result["ok"] for line_result in line_results)
        payload["lines"] = line_results
        return payload

    def alarm_payload(self, alarm_code, severity, message):
        payload = self.envelope("alarm")
        payload["code"] = alarm_code
        payload["severity"] = severity
        payload["message"] = message
        return payload

    def node_id(self):
        return self.settings.NODE_ID

    def now_iso(self):
        return format_iso(self.clock.epoch_seconds())

    def read_set_clock(self):
        epoch_seconds = self.clock.epoch_seconds()
        return epoch_seconds if is_clock_set(epoch_seconds) else None


def not_measured(unit):
    return {"value": None, "valid": False, "unit": unit, "reason": NOT_MEASURED}
