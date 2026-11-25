import binascii
import json
import tempfile
from types import SimpleNamespace

from contract import SERVER_STATUS_TOPIC, AlarmCode
from ds18b20_probes import Ds18b20Probes
from fakes import (
    SET_CLOCK_EPOCH_SECONDS,
    FakeBusSensors,
    FakeClock,
    FakeInstaller,
    FakeMachine,
    FakePublisher,
    RecordingLog,
    load_board,
)
from iso_time import format_iso
from node_agent import NodeAgent
from node_updates import NodeUpdates
from relay_lines import DRIVEN_LOW_LEVEL, RELEASED_LEVEL, ReleasedWhenHighLines
from slots import SlotStore

NODE_ID = "braize"
CONTROLLER = "nestjs-1"
HEATER_PIN = 20
HEAT_TAPE_PIN = 18
AIR_ROM = binascii.unhexlify("28e86e43d4e13c66")
DEADMAN_SECONDS = 600
NODE_ROOT = "tempestas/v1/node/" + NODE_ID
AIR_PROBE = {"28-3ce1d4436ee8": "air"}

SETTINGS = SimpleNamespace(
    NODE_ID=NODE_ID,
    NODE_KIND="pico",
    DEADMAN_SECONDS=DEADMAN_SECONDS,
    SAMPLE_INTERVAL_SECONDS=10,
)


def skip_sleep(milliseconds):
    return None


class AgentUnderTest:
    def __init__(self, clock=None, store=None, installer=None):
        self.clock = clock or FakeClock()
        self.store = store or SlotStore(tempfile.mkdtemp())
        self.installer = installer or FakeInstaller()
        self.resets = []
        self.publisher = FakePublisher()
        self.machine = FakeMachine()
        self.relay_lines = ReleasedWhenHighLines(
            self.machine,
            load_board("pico_w", self.machine),
            (HEATER_PIN, HEAT_TAPE_PIN),
            {HEATER_PIN: RELEASED_LEVEL, HEAT_TAPE_PIN: RELEASED_LEVEL},
        )
        self.relay_lines.claim_at_failsafe()
        probes = Ds18b20Probes(FakeBusSensors({AIR_ROM: 3.5}), AIR_PROBE, skip_sleep, RecordingLog())
        probes.start()
        log = RecordingLog()
        updates = NodeUpdates(self.store, self.installer, self.clock, log, lambda: self.resets.append(True))
        self.agent = NodeAgent(
            SETTINGS, self.publisher, self.relay_lines, probes, self.clock, log, "boot-1", updates
        )

    def deliver(self, topic_suffix, payload, is_retained=False):
        topic = SERVER_STATUS_TOPIC if topic_suffix == "server" else NODE_ROOT + topic_suffix
        self.agent.on_message(topic, json.dumps(payload).encode(), is_retained)

    def heartbeat(self):
        self.deliver("/control/heartbeat", {"controller": CONTROLLER, "epoch": 1})

    def command(self, level, pin=HEATER_PIN, is_retained=False, issued_by=CONTROLLER):
        self.deliver(
            "/gpio/set",
            {
                "schema": "gpioSet/1",
                "node": NODE_ID,
                "ts": format_iso(self.clock.epoch_seconds()),
                "id": "cmd-1",
                "issuedBy": issued_by,
                "expiresAt": format_iso(self.clock.epoch_seconds() + 30),
                "lines": [{"pin": pin, "level": level}],
            },
            is_retained,
        )

    def sync(self, level, pin=HEATER_PIN):
        self.deliver(
            "/gpio/sync",
            {
                "schema": "gpioSync/1",
                "node": NODE_ID,
                "ts": format_iso(self.clock.epoch_seconds()),
                "controller": CONTROLLER,
                "epoch": 1,
                "dryRun": False,
                "intent": [{"pin": pin, "level": level}],
            },
        )

    def has_logged(self, fragment):
        return any(fragment in line for line in self.agent.log.lines)

    def levels(self):
        return [self.relay_lines.read_level(pin) for pin in (HEATER_PIN, HEAT_TAPE_PIN)]

    def alarm_codes(self):
        return [message.payload["code"] for message in self.publisher.on_topic("/alarm")]


def test_subscribes_with_the_contract_quality_of_service():
    node = AgentUnderTest()
    assert node.agent.list_subscriptions() == [
        (NODE_ROOT + "/gpio/set", 1),
        (NODE_ROOT + "/gpio/sync", 1),
        (NODE_ROOT + "/control/heartbeat", 0),
        (NODE_ROOT + "/update", 1),
        (SERVER_STATUS_TOPIC, 1),
    ]


def test_announces_online_hello_and_the_lines_on_connect():
    node = AgentUnderTest()
    node.agent.announce()
    status, hello, *states = node.publisher.messages
    assert (status.payload["state"], status.is_retained) == ("online", True)
    assert hello.payload["capabilities"]["gpio"] == {
        "pins": [HEATER_PIN, HEAT_TAPE_PIN],
        "supportsReadback": True,
    }
    assert hello.payload["capabilities"]["sensors"][0]["sensorId"] == "air"
    assert hello.payload["capabilities"]["hasRtc"] is False
    assert hello.payload["kind"] == "pico"
    assert hello.payload["agentName"] == "agent-micropython"
    assert hello.payload["capabilities"]["contractMinor"] == 2
    assert [(state.payload["pin"], state.payload["level"], state.is_retained) for state in states] == [
        (HEATER_PIN, RELEASED_LEVEL, True),
        (HEAT_TAPE_PIN, RELEASED_LEVEL, True),
    ]


def test_obeys_the_bound_controller_and_reports_the_readback():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    result = node.publisher.on_topic("/gpio/result")[0].payload
    assert result["ok"] is True
    assert result["lines"] == [{"pin": HEATER_PIN, "requested": 0, "readback": 0, "ok": True}]
    assert node.levels() == [DRIVEN_LOW_LEVEL, RELEASED_LEVEL]
    assert node.publisher.on_topic("/gpio/state/20")[-1].payload["level"] == DRIVEN_LOW_LEVEL


def test_refuses_a_foreign_controller_and_leaves_the_lines_alone():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL, issued_by="intruder")
    assert node.alarm_codes() == [AlarmCode.CONTROLLER_CONFLICT]
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_ignores_a_sync_request_without_touching_the_lines():
    node = AgentUnderTest()
    node.heartbeat()
    node.sync(DRIVEN_LOW_LEVEL)
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]
    assert node.publisher.messages == []
    assert node.has_logged("ignored a gpio/sync")


def test_ignores_a_sync_request_before_any_heartbeat_and_binds_no_controller():
    node = AgentUnderTest()
    node.sync(DRIVEN_LOW_LEVEL)
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]
    assert node.publisher.messages == []
    assert node.has_logged("ignored a gpio/sync")
    assert node.agent.bound_controller is None


def test_drops_a_retained_command():
    node = AgentUnderTest()
    node.command(DRIVEN_LOW_LEVEL, is_retained=True)
    assert node.alarm_codes() == [AlarmCode.RETAINED_COMMAND_DROPPED]
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_refuses_commands_until_ntp_has_set_the_clock():
    node = AgentUnderTest(FakeClock(epoch_seconds=0))
    node.command(DRIVEN_LOW_LEVEL)
    assert node.publisher.on_topic("/gpio/result") == []
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_fails_safe_when_the_controller_goes_quiet_for_the_deadman():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    node.clock.advance_seconds(DEADMAN_SECONDS - 1)
    assert node.agent.check_deadman() is False
    node.clock.advance_seconds(1)
    assert node.agent.check_deadman() is True
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]
    assert node.alarm_codes() == [AlarmCode.DEADMAN_TRIPPED]


def test_tells_the_bus_the_lines_before_it_raises_the_alarm():
    node = AgentUnderTest()
    node.heartbeat()
    node.clock.advance_seconds(DEADMAN_SECONDS)
    node.agent.check_deadman()
    topics = node.publisher.topics()
    assert topics[-1].endswith("/alarm")
    assert topics[:-1] == [NODE_ROOT + "/gpio/state/20", NODE_ROOT + "/gpio/state/18"]


def test_trips_once_and_clears_when_heartbeats_resume():
    node = AgentUnderTest()
    node.heartbeat()
    node.clock.advance_seconds(DEADMAN_SECONDS)
    node.agent.check_deadman()
    node.clock.advance_seconds(DEADMAN_SECONDS)
    assert node.agent.check_deadman() is False
    node.heartbeat()
    assert node.alarm_codes() == [AlarmCode.DEADMAN_TRIPPED, AlarmCode.DEADMAN_CLEARED]


def test_has_no_deadman_before_the_first_heartbeat():
    node = AgentUnderTest()
    node.clock.advance_seconds(DEADMAN_SECONDS * 10)
    assert node.agent.check_deadman() is False


def test_holds_the_lines_when_the_server_goes_offline():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    node.deliver("server", {"state": "offline"})
    assert node.levels() == [DRIVEN_LOW_LEVEL, RELEASED_LEVEL]
    assert node.alarm_codes() == []


def test_still_fails_safe_on_the_deadman_after_the_server_goes_offline():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    node.deliver("server", {"state": "offline"})
    node.clock.advance_seconds(DEADMAN_SECONDS)
    assert node.agent.check_deadman() is True
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_says_hello_again_when_the_server_comes_back_online():
    node = AgentUnderTest()
    node.deliver("server", {"state": "offline"})
    node.deliver("server", {"state": "online"})
    hellos = node.publisher.on_topic("/hello")
    assert [(hello.payload["bootId"], hello.is_retained) for hello in hellos] == [("boot-1", False)]
    assert hellos[0].payload["capabilities"]["gpio"]["pins"] == [HEATER_PIN, HEAT_TAPE_PIN]


def test_does_not_repeat_the_hello_for_the_retained_online_replayed_on_connect():
    node = AgentUnderTest()
    node.agent.announce()
    node.deliver("server", {"state": "online"}, is_retained=True)
    assert len(node.publisher.on_topic("/hello")) == 1


def test_a_server_coming_back_online_leaves_the_lines_alone():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    node.deliver("server", {"state": "online"})
    assert node.levels() == [DRIVEN_LOW_LEVEL, RELEASED_LEVEL]
    assert node.alarm_codes() == []


def test_publishes_each_reading_with_a_rising_sequence():
    node = AgentUnderTest()
    node.agent.publish_readings()
    node.agent.publish_readings()
    samples = [message.payload for message in node.publisher.on_topic("/sensor/air/sample")]
    assert [sample["seq"] for sample in samples] == [1, 2]
    assert samples[0]["measurements"]["tempC"] == {"value": 3.5, "valid": True, "unit": "C"}
    assert samples[0]["measurements"]["co2Ppm"]["valid"] is False


def test_reports_an_unmanaged_pin_as_failed_and_publishes_no_state_for_it():
    node = AgentUnderTest()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL, pin=99)
    result = node.publisher.on_topic("/gpio/result")[0].payload
    assert result["ok"] is False
    assert result["lines"][0]["readback"] is None
    assert node.publisher.on_topic("/gpio/state/99") == []


def test_holds_back_line_state_until_ntp_has_set_the_clock():
    node = AgentUnderTest(FakeClock(epoch_seconds=0))
    node.agent.announce()
    assert node.publisher.on_topic("/gpio/state/20") == []
    node.clock.start_epoch_seconds = SET_CLOCK_EPOCH_SECONDS
    node.agent.on_clock_set()
    states = node.publisher.on_topic("/gpio/state/20") + node.publisher.on_topic("/gpio/state/18")
    assert [state.payload["ts"][:4] for state in states] == ["2026", "2026"]


def test_still_raises_the_alarm_when_failing_safe_before_the_clock_is_set():
    node = AgentUnderTest(FakeClock(epoch_seconds=0))
    node.heartbeat()
    node.clock.advance_seconds(DEADMAN_SECONDS)
    node.agent.check_deadman()
    assert node.alarm_codes() == [AlarmCode.DEADMAN_TRIPPED]
    assert node.levels() == [RELEASED_LEVEL, RELEASED_LEVEL]


def test_asks_to_hold_only_alarms_and_results_while_offline():
    node = AgentUnderTest()
    node.agent.announce()
    node.heartbeat()
    node.command(DRIVEN_LOW_LEVEL)
    node.command(DRIVEN_LOW_LEVEL, issued_by="intruder")
    node.agent.publish_readings()
    held_topics = {
        message.topic.split("/braize/")[-1]
        for message in node.publisher.messages
        if message.should_hold_while_offline
    }
    assert held_topics == {"gpio/result", "alarm"}
