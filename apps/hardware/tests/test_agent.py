"""Agent behaviour: capabilities, sampling, the dead-man, and the GPIO seam."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from tempestas_agent import contract
from tempestas_agent import gpio as gpio_mod
from tempestas_agent.agent import Agent, build_backends
from tempestas_agent.config import AgentConfig, GpioConfig, SensorConfig
from tempestas_agent.sensor import Measurement, Reading, SimulatedSensor


class FakeClient:
    def __init__(self):
        self.published: list[tuple[str, dict, int, bool]] = []

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, json.loads(payload), qos, retain))

    def topics(self):
        return [t for t, _, _, _ in self.published]


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def make_agent(lines=(), failsafe=None, deadman_s=30.0):
    config = AgentConfig(
        node_id="bench",
        sensor=SensorConfig(kind="simulated", sensor_id="scd4x-v"),
        gpio=GpioConfig(lines=lines, failsafe=failsafe or {}),
        deadman_s=deadman_s,
    )
    gpio = gpio_mod.SimulatedGpio() if lines else gpio_mod.NoGpio()
    gpio.claim(lines, failsafe or {})
    clock = FakeClock()
    agent = Agent(config, FakeClient(), SimulatedSensor(gpio=gpio), gpio, clock=clock)
    return agent, clock


class TestCapabilities:
    # The Stage B property. With no lines the node advertises no gpio at all, so
    # the server's pin check refuses to create a device here and there is no
    # path by which a pin on this node can be addressed.
    def test_a_sensor_only_node_advertises_no_gpio(self):
        agent, _ = make_agent(lines=())
        caps = agent.capabilities()
        assert "gpio" not in caps
        assert caps["sensors"][0]["sensorId"] == "scd4x-v"

    def test_a_node_with_lines_advertises_exactly_those_pins(self):
        agent, _ = make_agent(lines=(16, 20), failsafe={16: 1, 20: 1})
        assert agent.capabilities()["gpio"] == {"pins": [16, 20], "supportsReadback": True}

    def test_hello_carries_a_boot_id_so_a_reboot_is_detectable(self):
        agent, _ = make_agent()
        hello = agent.hello_payload()
        assert hello["bootId"].startswith("boot-")
        assert hello["schema"] == contract.SCHEMAS["hello"]
        # The dedupe of readings is scoped to this, so it must never be empty.
        assert len(hello["bootId"]) > len("boot-")


class TestSampling:
    def test_sequence_numbers_increment_so_duplicates_are_detectable(self):
        agent, _ = make_agent()
        reading = agent.sensor.read()
        first = agent.sample_payload(reading)["seq"]
        second = agent.sample_payload(reading)["seq"]
        assert second == first + 1

    def test_an_invalid_co2_crosses_the_wire_as_null_with_a_reason(self):
        agent, _ = make_agent()
        reading = Reading(
            co2_ppm=Measurement(None, False, "ppm", "ZERO_READING"),
            temperature_c=Measurement(21.5, True, "C"),
            humidity_pct=Measurement(55.0, True, "%"),
        )
        payload = agent.sample_payload(reading)
        assert payload["measurements"]["co2Ppm"] == {
            "value": None,
            "valid": False,
            "unit": "ppm",
            "reason": "ZERO_READING",
        }
        # And the rest of the sample is still usable - a bad CO2 does not
        # invalidate a good temperature.
        assert payload["measurements"]["tempC"]["value"] == 21.5


class TestGpioSeam:
    # Not a silent no-op: a write to a node with no GPIO is a programming error
    # and has to be loud.
    def test_a_sensor_only_node_refuses_to_drive_a_pin(self):
        agent, _ = make_agent(lines=())
        result = agent.on_command(_command(), retained=False)
        assert result["ok"] is False
        assert result["lines"][0]["readback"] is None
        assert "no GPIO configured" in result["lines"][0]["error"]

    def test_a_node_with_lines_drives_and_reads_back(self):
        agent, _ = make_agent(lines=(16,), failsafe={16: 1})
        agent.bound_controller = "ctl"
        result = agent.on_command(_command(issuedBy="ctl"), retained=False)
        assert result["ok"] is True
        assert result["lines"] == [{"pin": 16, "requested": 0, "readback": 0, "ok": True}]

    def test_a_refused_command_produces_no_result_at_all(self):
        agent, _ = make_agent(lines=(16,), failsafe={16: 1})
        agent.bound_controller = "ctl"
        assert agent.on_command(_command(issuedBy="someone-else"), retained=False) is None

    # A claimed line nobody has written is UNKNOWN, not off.
    def test_an_unwritten_line_reads_back_unknown(self):
        agent, _ = make_agent(lines=(16,), failsafe={16: 1})
        assert agent.gpio.level(16) is None


class TestDeadman:
    def test_does_not_trip_before_the_first_heartbeat(self):
        agent, clock = make_agent(deadman_s=30)
        clock.advance(600)
        assert agent.check_deadman() is False

    def test_trips_when_the_heartbeats_stop(self):
        agent, clock = make_agent(lines=(16,), failsafe={16: 1}, deadman_s=30)
        agent.on_heartbeat(_heartbeat())
        agent.gpio.write(16, 0)  # energised

        clock.advance(31)
        assert agent.check_deadman() is True
        # It drove the line to its declared safe level with no server involved.
        assert agent.gpio.level(16) == 1
        assert any(
            p.get("code") == contract.AlarmCode.DEADMAN_TRIPPED
            for _, p, _, _ in agent.client.published
        )

    def test_does_not_trip_while_heartbeats_keep_arriving(self):
        agent, clock = make_agent(deadman_s=30)
        for _ in range(5):
            agent.on_heartbeat(_heartbeat())
            clock.advance(20)
            assert agent.check_deadman() is False

    def test_trips_once_and_then_clears_when_the_controller_returns(self):
        agent, clock = make_agent(deadman_s=30)
        agent.on_heartbeat(_heartbeat())
        clock.advance(31)
        assert agent.check_deadman() is True
        assert agent.check_deadman() is False  # already tripped: no alarm storm

        agent.on_heartbeat(_heartbeat())
        assert agent.deadman_tripped is False
        assert any(
            p.get("code") == contract.AlarmCode.DEADMAN_CLEARED
            for _, p, _, _ in agent.client.published
        )

    def test_binds_to_the_controller_that_heartbeats(self):
        agent, _ = make_agent()
        agent.on_heartbeat(_heartbeat(controller="nestjs-99"))
        assert agent.bound_controller == "nestjs-99"


class TestBackendWiring:
    def test_no_lines_builds_a_backend_that_cannot_open_a_chip(self):
        config = AgentConfig(node_id="bench", sensor=SensorConfig(kind="simulated"))
        _, gpio = build_backends(config, simulated=False)
        assert isinstance(gpio, gpio_mod.NoGpio)

    # The real backend is Stage C and must not be reachable by accident.
    def test_asking_for_real_gpio_fails_loudly_rather_than_pretending(self):
        config = AgentConfig(
            node_id="bench",
            sensor=SensorConfig(kind="simulated"),
            gpio=GpioConfig(lines=(16,), failsafe={16: 1}),
        )
        try:
            build_backends(config, simulated=False)
        except NotImplementedError as err:
            assert "Stage C" in str(err)
        else:
            raise AssertionError("a real GPIO backend should not exist yet")


def _command(**overrides) -> bytes:
    now = datetime.now(UTC)
    body = {
        "schema": contract.SCHEMAS["gpioSet"],
        "node": "bench",
        "ts": now.isoformat(),
        "id": "cmd-1",
        "issuedBy": "ctl",
        "expiresAt": (now + timedelta(seconds=15)).isoformat().replace("+00:00", "Z"),
        "lines": [{"pin": 16, "level": 0}],
    }
    body.update(overrides)
    return json.dumps(body).encode()


def _heartbeat(controller: str = "ctl") -> bytes:
    return json.dumps(
        {"schema": "heartbeat/1", "node": "bench", "ts": "", "controller": controller, "epoch": 1}
    ).encode()
