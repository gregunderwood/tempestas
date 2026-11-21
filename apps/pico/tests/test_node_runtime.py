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


def install_pico_modules(ntp):
    stubs = {
        "machine": types.SimpleNamespace(),
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
    def __init__(self, failure=None):
        self.failure = failure
        self.is_closed = False
        self.unanswered_pings = 0

    def check_msg(self):
        if self.failure is not None:
            raise self.failure

    def close(self):
        self.is_closed = True


class QuietAgent:
    def __init__(self, failure=None):
        self.failure = failure

    def on_message(self, topic, payload, is_retained):
        raise self.failure


@pytest.fixture
def runtime():
    ntp = FakeNtp()
    module = install_pico_modules(ntp)
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
