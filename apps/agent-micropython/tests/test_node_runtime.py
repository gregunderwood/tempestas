import sys
import types

import pytest

from fakes import FakeClock, RecordingLog

DAY_SECONDS = 86400


class FakeWlan:
    def __init__(self, interface):
        self.is_connected = True

    def isconnected(self):
        return self.is_connected


class FakeNtp:
    def __init__(self):
        self.attempts = 0
        self.failure = None

    def settime(self):
        self.attempts += 1
        if self.failure is not None:
            raise self.failure


def install_device_modules(ntp):
    stubs = {
        "machine": types.SimpleNamespace(),
        "board": types.SimpleNamespace(keep_wifi_awake=lambda wifi: None),
        "network": types.SimpleNamespace(STA_IF=0, WLAN=FakeWlan),
        "ntptime": ntp,
        "onewire": types.SimpleNamespace(),
        "ds18x20": types.SimpleNamespace(),
        "credentials": types.SimpleNamespace(
            WIFI_SSID="bench", WIFI_PASSWORD="bench", MQTT_USERNAME="braize", MQTT_PASSWORD="bench"
        ),
    }
    for name, module in stubs.items():
        sys.modules[name] = module
    sys.modules.pop("node_runtime", None)
    import node_runtime

    return node_runtime


class FakeWatchdog:
    def feed(self):
        pass


class FakeClient:
    def __init__(self, failure=None, deferred_messages=()):
        self.failure = failure
        self.is_closed = False
        self.unanswered_pings = 0
        self.published_topics = []
        self.deferred_messages = list(deferred_messages)

    def take_deferred_messages(self):
        deferred_messages = self.deferred_messages
        self.deferred_messages = []
        return deferred_messages

    def publish(self, topic, text, is_retained, quality_of_service):
        self.published_topics.append(topic)

    def serve_one_message(self):
        if self.failure is not None:
            raise self.failure

    def close(self):
        self.is_closed = True


class QuietAgent:
    def __init__(self, failure=None):
        self.failure = failure
        self.clock_set_count = 0
        self.received_messages = []

    def on_clock_set(self):
        self.clock_set_count += 1

    def on_message(self, topic, payload, is_retained):
        if self.failure is not None:
            raise self.failure
        self.received_messages.append((topic, payload, is_retained))


@pytest.fixture
def runtime():
    ntp = FakeNtp()
    module = install_device_modules(ntp)
    clock = FakeClock()
    publisher = module.BrokerPublisher()
    connection = module.Connection(FakeWatchdog(), clock, QuietAgent(), publisher)
    connection.connect_attempts = []
    connection.connect_to_broker = lambda: connection.connect_attempts.append(clock.ticks())
    module.log = RecordingLog()
    return types.SimpleNamespace(
        module=module, ntp=ntp, clock=clock, publisher=publisher, connection=connection
    )


def test_reconnects_at_once_after_a_connection_that_lasted_a_week(runtime):
    runtime.connection.keep_up()
    runtime.publisher.client = FakeClient()
    for _day in range(7):
        runtime.clock.advance_seconds(DAY_SECONDS)
        runtime.connection.keep_up()
    runtime.publisher.drop("broker restarted")
    runtime.connection.keep_up()
    assert len(runtime.connection.connect_attempts) == 2


def test_spaces_failed_connects_apart(runtime):
    runtime.connection.keep_up()
    runtime.clock.advance_seconds(1)
    runtime.connection.keep_up()
    assert len(runtime.connection.connect_attempts) == 1


def test_retries_a_failed_ntp_sync_a_minute_later_not_every_loop(runtime):
    runtime.ntp.failure = OSError("timed out")
    runtime.connection.resync_clock_while_online()
    runtime.clock.advance_seconds(1)
    runtime.connection.resync_clock_while_online()
    assert runtime.ntp.attempts == 1
    runtime.clock.advance_seconds(60)
    runtime.connection.resync_clock_while_online()
    assert runtime.ntp.attempts == 2


def test_resyncs_the_clock_hourly_while_connected(runtime):
    runtime.connection.resync_clock_while_online()
    runtime.clock.advance_seconds(3599)
    runtime.connection.resync_clock_while_online()
    runtime.clock.advance_seconds(1)
    runtime.connection.resync_clock_while_online()
    assert runtime.ntp.attempts == 2


def test_syncs_at_once_when_wifi_returns_after_a_week_away(runtime):
    runtime.connection.resync_clock_while_online()
    runtime.connection.wifi.is_connected = False
    for _day in range(7):
        runtime.clock.advance_seconds(DAY_SECONDS)
        runtime.connection.resync_clock_while_online()
    runtime.connection.wifi.is_connected = True
    runtime.connection.resync_clock_while_online()
    assert runtime.ntp.attempts == 2


def test_drops_and_closes_on_any_transport_failure(runtime):
    client = FakeClient(IndexError("index out of range"))
    runtime.publisher.client = client
    runtime.connection.serve_pending_messages()
    assert runtime.publisher.client is None
    assert client.is_closed


def test_a_message_that_breaks_its_handler_does_not_end_the_loop(runtime):
    runtime.connection.agent = QuietAgent(KeyError("pin"))
    runtime.connection.deliver(b"tempestas/v1/node/braize/gpio/set", b"{}", False)
    assert "could not be handled" in runtime.module.log.lines[-1]


def test_drops_the_connection_when_wifi_goes(runtime):
    client = FakeClient()
    runtime.publisher.client = client
    runtime.connection.wifi.is_connected = False
    runtime.connection.serve_pending_messages()
    assert runtime.publisher.client is None and client.is_closed


def test_drops_the_connection_when_the_broker_stops_answering_pings(runtime):
    client = FakeClient()
    client.unanswered_pings = runtime.module.UNANSWERED_PINGS_BEFORE_DROPPING
    runtime.publisher.client = client
    runtime.connection.serve_pending_messages()
    assert runtime.publisher.client is None


def test_holds_only_what_it_is_told_to_while_offline(runtime):
    publisher = runtime.publisher
    publisher.publish("alarm", "{}", False, 1, True)
    publisher.publish("gpio/result", "{}", False, 1, True)
    publisher.publish("hello", "{}", False, 1, False)
    publisher.publish("sensor/air/sample", "{}", False, 0, False)
    client = FakeClient()
    publisher.client = client
    publisher.send_held_messages()
    assert client.published_topics == ["alarm", "gpio/result"]
    assert publisher.held_messages == []


def test_a_command_acknowledged_before_the_connection_dropped_is_still_handled(runtime):
    runtime.publisher.client = FakeClient(
        deferred_messages=[(b"tempestas/v1/node/braize/gpio/set", b"{}", False)]
    )
    runtime.publisher.drop("publish failed")
    runtime.connection.serve_pending_messages()
    assert runtime.connection.agent.received_messages == [("tempestas/v1/node/braize/gpio/set", b"{}", False)]
    runtime.connection.serve_pending_messages()
    assert len(runtime.connection.agent.received_messages) == 1


def test_keeps_only_the_newest_messages_when_offline_for_long(runtime):
    for number in range(runtime.module.MAX_MESSAGES_HELD_OFFLINE + 5):
        runtime.publisher.publish("alarm/%d" % number, "{}", False, 1, True)
    held_topics = [message[0] for message in runtime.publisher.held_messages]
    assert len(held_topics) == runtime.module.MAX_MESSAGES_HELD_OFFLINE
    assert held_topics[-1] == "alarm/%d" % (runtime.module.MAX_MESSAGES_HELD_OFFLINE + 4)


def test_tells_the_agent_when_ntp_has_set_the_clock(runtime):
    runtime.connection.resync_clock_while_online()
    assert runtime.connection.agent.clock_set_count == 1


def test_a_client_dropped_by_its_own_handler_is_not_dropped_twice(runtime):
    class ClientDroppedMidMessage(FakeClient):
        def serve_one_message(self):
            runtime.publisher.drop("publish failed")
            raise AttributeError("'NoneType' object has no attribute 'write'")

    runtime.publisher.client = ClientDroppedMidMessage()
    runtime.connection.serve_pending_messages()
    assert sum("dropping" in line for line in runtime.module.log.lines) == 1


class LoopEnded(Exception):
    pass


class TendingAgent:
    def __init__(self):
        self.tended_while_connected = []

    def publish_readings(self):
        pass

    def check_deadman(self):
        pass

    def tend_update(self, is_connected):
        self.tended_while_connected.append(is_connected)


def end_the_loop(milliseconds):
    raise LoopEnded()


@pytest.mark.parametrize("client", [None, FakeClient()])
def test_each_pass_of_the_main_loop_tends_the_update_gate(runtime, monkeypatch, client):
    agent = TendingAgent()
    runtime.publisher.client = client
    runtime.connection.keep_up = lambda: None
    runtime.connection.resync_clock_while_online = lambda: None
    runtime.connection.serve_pending_messages = lambda: None
    monkeypatch.setattr(runtime.module, "time", types.SimpleNamespace(sleep_ms=end_the_loop))

    with pytest.raises(LoopEnded):
        runtime.module.run_forever(FakeWatchdog(), runtime.clock, agent, runtime.connection)

    assert agent.tended_while_connected == [client is not None]


def test_builds_the_update_chain_for_this_board_and_version(runtime, monkeypatch):
    import settings
    from agent_version import read_agent_version

    monkeypatch.setattr(runtime.module, "machine", types.SimpleNamespace(reset=lambda: None))
    watchdog = FakeWatchdog()

    updates = runtime.module.build_updates(watchdog, runtime.clock)

    assert updates.installer.board_name == settings.BOARD
    assert updates.installer.running_version == read_agent_version()
    assert updates.installer.fetcher.feed_watchdog == watchdog.feed
    assert updates.gate is None


def test_says_whether_a_message_reached_the_broker(runtime):
    assert not runtime.publisher.publish("topic", "{}", False, 1, False)
    runtime.publisher.client = FakeClient()
    assert runtime.publisher.publish("topic", "{}", False, 1, False)
