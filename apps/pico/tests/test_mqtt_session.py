import struct

from mqtt_session import DeferringMqttClient

PUBACK = 0x40
PUBLISH = 0x30
FIRST_PACKET_ID = 1


def publish_packet(topic, payload):
    body = struct.pack("!H", len(topic)) + topic + payload
    return bytes((PUBLISH, len(body))) + body


def puback_packet(packet_id):
    return bytes((PUBACK, 2)) + struct.pack("!H", packet_id)


class FakeSocket:
    def __init__(self, incoming):
        self.incoming = bytearray(incoming)
        self.written = bytearray()
        self.timeout = None
        self.is_closed = False

    def read(self, size):
        chunk = bytes(self.incoming[:size])
        del self.incoming[:size]
        return chunk if chunk or self.timeout != 0 else None

    def write(self, packet, length=None):
        self.written += bytes(packet[:length] if length is not None else packet)

    def setblocking(self, is_blocking):
        self.timeout = None if is_blocking else 0

    def settimeout(self, seconds):
        self.timeout = seconds

    def close(self):
        self.is_closed = True


PINGRESP = bytes((0xD0, 0))


class WatchdogFeeds:
    def __init__(self):
        self.count = 0

    def __call__(self):
        self.count += 1


def connected_client(incoming, handled, feed_watchdog=None):
    client = DeferringMqttClient(feed_watchdog or WatchdogFeeds(), "braize", "broker")
    client.sock = FakeSocket(incoming)
    client.socket_timeout = 5
    client.set_message_handler(lambda topic, payload, is_retained: handled.append((topic, payload)))
    return client


def test_a_message_arriving_mid_publish_waits_until_the_publish_is_acknowledged():
    handled = []
    client = connected_client(publish_packet(b"heartbeat", b"{}") + puback_packet(FIRST_PACKET_ID), handled)
    client.publish(b"result", b"{}", False, 1)
    assert handled == []
    assert client.check_msg() == PUBLISH
    assert handled == [(b"heartbeat", b"{}")]


def test_a_handler_that_publishes_cannot_steal_the_outer_acknowledgement():
    handled = []
    client = connected_client(
        publish_packet(b"heartbeat", b"{}")
        + puback_packet(FIRST_PACKET_ID)
        + puback_packet(FIRST_PACKET_ID + 1),
        handled,
    )

    def publish_while_handling(topic, payload, is_retained):
        handled.append((topic, payload))
        client.publish(b"alarm", b"{}", False, 1)

    client.message_handler = publish_while_handling
    client.publish(b"state", b"{}", False, 1)
    client.check_msg()
    assert handled == [(b"heartbeat", b"{}")]
    assert client.sock.incoming == b""


def test_the_socket_timeout_survives_a_message_check():
    client = connected_client(b"", [])
    client.check_msg()
    client.sock.incoming += puback_packet(FIRST_PACKET_ID)
    client.check_msg()
    assert client.sock.timeout == 5


def test_close_releases_the_socket_once():
    client = connected_client(b"", [])
    socket = client.sock
    client.close()
    client.close()
    assert socket.is_closed and client.sock is None


def test_feeds_the_watchdog_before_every_wait_for_a_packet():
    feeds = WatchdogFeeds()
    client = connected_client(publish_packet(b"heartbeat", b"{}") + puback_packet(FIRST_PACKET_ID), [], feeds)
    client.publish(b"result", b"{}", False, 1)
    assert feeds.count == 2


def test_counts_pings_until_the_broker_answers():
    client = connected_client(b"", [])
    client.ping()
    client.ping()
    assert client.unanswered_pings == 2
    client.sock.incoming += PINGRESP
    client.check_msg()
    assert client.unanswered_pings == 0
