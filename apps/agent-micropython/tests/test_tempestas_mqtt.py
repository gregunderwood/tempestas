import struct

import tempestas_mqtt
from tempestas_mqtt import (
    HIGHEST_PACKET_ID,
    PUBACK,
    PUBLISH,
    SUBACK,
    MqttError,
    MqttSession,
    encode_remaining_length,
)

FIRST_PACKET_ID = 1
SOCKET_TIMEOUT_SECONDS = 3
PINGRESP_PACKET = bytes((0xD0, 0))
CONNACK_ACCEPTED = bytes((0x20, 2, 0, 0))


def publish_packet(topic, payload, quality_of_service=0, is_retained=False, packet_id=None):
    body = struct.pack("!H", len(topic)) + topic
    if quality_of_service:
        body += struct.pack("!H", packet_id)
    body += payload
    first_byte = PUBLISH | quality_of_service << 1 | (1 if is_retained else 0)
    return bytes((first_byte,)) + encode_remaining_length(len(body)) + body


def acknowledgement_packet(packet_type, packet_id, *trailing):
    body = struct.pack("!H", packet_id) + bytes(trailing)
    return bytes((packet_type, len(body))) + body


class FakeSocket:
    def __init__(self, incoming=b""):
        self.incoming = bytearray(incoming)
        self.written = bytearray()
        self.timeout = None
        self.is_closed = False
        self.address = None

    def read(self, size):
        chunk = bytes(self.incoming[:size])
        del self.incoming[:size]
        return chunk if chunk or self.timeout != 0 else None

    def write(self, packet):
        self.written += packet

    def setblocking(self, is_blocking):
        self.timeout = None if is_blocking else 0

    def settimeout(self, seconds):
        self.timeout = seconds

    def connect(self, address):
        self.address = address

    def close(self):
        self.is_closed = True


class WatchdogFeeds:
    def __init__(self):
        self.count = 0

    def __call__(self):
        self.count += 1


def build_session(handled=None, feed_watchdog=None):
    session = MqttSession(
        feed_watchdog or WatchdogFeeds(), "tempestas-braize", "broker", 1883, "braize", "secret", 60
    )
    session.set_message_handler(
        lambda topic, payload, is_retained: (handled if handled is not None else []).append(
            (topic, payload, is_retained)
        )
    )
    return session


def connected_session(incoming, handled=None, feed_watchdog=None):
    session = build_session(handled, feed_watchdog)
    session.socket_connection = FakeSocket(incoming)
    session.timeout_seconds = SOCKET_TIMEOUT_SECONDS
    return session


def test_connects_with_a_clean_session_credentials_and_a_last_will(monkeypatch):
    fake_socket = FakeSocket(CONNACK_ACCEPTED)
    monkeypatch.setattr(tempestas_mqtt.socket, "socket", lambda: fake_socket)
    monkeypatch.setattr(
        tempestas_mqtt.socket, "getaddrinfo", lambda host, port: [(None, None, None, "", (host, port))]
    )
    session = build_session()
    session.set_last_will("tempestas/v1/node/braize/status", '{"state": "offline"}', True, 1)
    session.connect(SOCKET_TIMEOUT_SECONDS)
    expected_body = (
        b"\x00\x04MQTT\x04"
        + bytes((0x02 | 0x04 | 1 << 3 | 0x20 | 0x40 | 0x80,))
        + struct.pack("!H", 60)
        + b"\x00\x10tempestas-braize"
        + b"\x00\x1ftempestas/v1/node/braize/status"
        + b'\x00\x14{"state": "offline"}'
        + b"\x00\x06braize"
        + b"\x00\x06secret"
    )
    assert fake_socket.address == ("broker", 1883)
    assert bytes(fake_socket.written) == b"\x10" + encode_remaining_length(len(expected_body)) + expected_body


def test_refuses_a_connection_the_broker_rejects():
    session = connected_session(bytes((0x20, 2, 0, 5)))
    try:
        session.read_connack()
    except MqttError as error:
        assert "return code 5" in str(error)
    else:
        raise AssertionError("a refused CONNACK was accepted")


def test_publishes_at_qos_one_and_waits_for_its_own_acknowledgement():
    session = connected_session(acknowledgement_packet(PUBACK, FIRST_PACKET_ID))
    session.publish("tempestas/v1/node/braize/alarm", "{}", False, 1)
    assert bytes(session.socket_connection.written) == publish_packet(
        b"tempestas/v1/node/braize/alarm", b"{}", 1, packet_id=FIRST_PACKET_ID
    )
    assert session.socket_connection.incoming == b""


def test_a_stray_acknowledgement_is_read_whole_and_skipped():
    session = connected_session(
        acknowledgement_packet(SUBACK, 9, 0)
        + acknowledgement_packet(PUBACK, 7)
        + acknowledgement_packet(PUBACK, 1)
    )
    session.publish("result", "{}", False, 1)
    assert session.socket_connection.incoming == b""


def test_a_refused_subscription_raises():
    session = connected_session(acknowledgement_packet(SUBACK, FIRST_PACKET_ID, 0x80))
    try:
        session.subscribe("tempestas/v1/node/braize/gpio/set", 1)
    except MqttError:
        return
    raise AssertionError("a refused subscription was accepted")


def test_packet_ids_wrap_without_ever_being_zero():
    session = build_session()
    session.last_packet_id = HIGHEST_PACKET_ID - 1
    assert [session.next_packet_id() for _attempt in range(3)] == [HIGHEST_PACKET_ID, 1, 2]


def test_delivers_a_message_with_its_retain_flag_and_acknowledges_qos_one_first():
    handled = []
    session = connected_session(publish_packet(b"set", b"{}", 1, is_retained=True, packet_id=42), handled)
    assert session.serve_one_message() is True
    assert handled == [(b"set", b"{}", True)]
    assert bytes(session.socket_connection.written) == acknowledgement_packet(PUBACK, 42)


def test_a_message_arriving_mid_publish_waits_until_the_publish_is_acknowledged():
    handled = []
    session = connected_session(
        publish_packet(b"heartbeat", b"{}") + acknowledgement_packet(PUBACK, FIRST_PACKET_ID), handled
    )
    session.publish("result", "{}", False, 1)
    assert handled == []
    assert session.serve_one_message() is True
    assert handled == [(b"heartbeat", b"{}", False)]


def test_a_handler_that_publishes_cannot_steal_the_outer_acknowledgement():
    handled = []
    session = connected_session(
        publish_packet(b"heartbeat", b"{}")
        + acknowledgement_packet(PUBACK, FIRST_PACKET_ID)
        + acknowledgement_packet(PUBACK, FIRST_PACKET_ID + 1),
        handled,
    )

    def publish_while_handling(topic, payload, is_retained):
        handled.append(topic)
        session.publish("alarm", "{}", False, 1)

    session.set_message_handler(publish_while_handling)
    session.publish("state", "{}", False, 1)
    session.serve_one_message()
    assert handled == [b"heartbeat"]
    assert session.socket_connection.incoming == b""


def test_feeds_the_watchdog_before_every_wait_for_a_packet():
    feeds = WatchdogFeeds()
    session = connected_session(
        publish_packet(b"heartbeat", b"{}") + acknowledgement_packet(PUBACK, FIRST_PACKET_ID),
        feed_watchdog=feeds,
    )
    session.publish("result", "{}", False, 1)
    assert feeds.count == 2


def test_the_socket_timeout_survives_a_check_for_messages():
    session = connected_session(b"")
    assert session.serve_one_message() is False
    assert session.socket_connection.timeout == SOCKET_TIMEOUT_SECONDS


def test_counts_pings_until_the_broker_answers():
    session = connected_session(b"")
    session.ping()
    session.ping()
    assert session.unanswered_pings == 2
    session.socket_connection.incoming += PINGRESP_PACKET
    session.serve_one_message()
    assert session.unanswered_pings == 0


def test_a_closed_connection_raises_rather_than_reading_nothing_forever():
    session = connected_session(b"")
    session.socket_connection.setblocking(True)
    try:
        session.receive_packet()
    except MqttError as error:
        assert "closed" in str(error)
    else:
        raise AssertionError("an empty read was not treated as a closed connection")


def test_close_releases_the_socket_once():
    session = connected_session(b"")
    fake_socket = session.socket_connection
    session.close()
    session.close()
    assert fake_socket.is_closed and session.socket_connection is None


def test_hands_over_messages_still_held_so_a_dropped_session_does_not_lose_them():
    session = connected_session(publish_packet(b"set", b"{}", 1, packet_id=5))
    session.is_awaiting_acknowledgement = True
    session.receive_packet()
    assert session.take_deferred_messages() == [(b"set", b"{}", False)]
    assert session.take_deferred_messages() == []
