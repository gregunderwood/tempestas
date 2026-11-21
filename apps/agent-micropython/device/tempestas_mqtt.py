"""From umqtt.simple 1.8.1 (MIT, see tempestas_mqtt.LICENSE), under a name no firmware freezes in."""

import socket
import struct

CONNECT = 0x10
CONNACK = 0x20
PUBLISH = 0x30
PUBACK = 0x40
SUBSCRIBE = 0x82
SUBACK = 0x90
PINGREQ = 0xC0
PINGRESP = 0xD0
PACKET_TYPE_MASK = 0xF0

PROTOCOL_NAME_AND_LEVEL = b"\x00\x04MQTT\x04"
CLEAN_SESSION_FLAG = 0x02
WILL_FLAG = 0x04
WILL_QOS_SHIFT = 3
WILL_RETAIN_FLAG = 0x20
PASSWORD_FLAG = 0x40
USERNAME_FLAG = 0x80

RETAIN_FLAG = 0x01
QOS_SHIFT = 1
QOS_MASK = 0x06
HIGHEST_SUPPORTED_QOS = 1

CONNACK_PACKET_LENGTH = 4
CONNACK_LENGTH = 2
PACKET_ID_LENGTH = 2
STRING_LENGTH_PREFIX = 2
CONNECTION_ACCEPTED = 0
SUBSCRIPTION_REFUSED = 0x80
HIGHEST_PACKET_ID = 0xFFFF

LENGTH_DIGIT_BITS = 7
LENGTH_DIGIT_MASK = 0x7F
LENGTH_CONTINUES = 0x80

UNSIGNED_SHORT_BIG_ENDIAN = "!H"
FOUR_UNSIGNED_BYTES = "!BBBB"
SINGLE_BYTE = 1


class MqttError(Exception):
    pass


def encode_remaining_length(length):
    encoded = bytearray()
    while True:
        digit = length & LENGTH_DIGIT_MASK
        length >>= LENGTH_DIGIT_BITS
        if length:
            digit |= LENGTH_CONTINUES
        encoded.append(digit)
        if not length:
            return bytes(encoded)


def encode_unsigned_short(value):
    return struct.pack(UNSIGNED_SHORT_BIG_ENDIAN, value)


def decode_unsigned_short(two_bytes):
    return struct.unpack(UNSIGNED_SHORT_BIG_ENDIAN, two_bytes)[0]


def encode_bytes(text):
    return text.encode() if isinstance(text, str) else bytes(text)


def encode_string(text):
    encoded = encode_bytes(text)
    return encode_unsigned_short(len(encoded)) + encoded


def build_packet(first_byte, body):
    return bytes((first_byte,)) + encode_remaining_length(len(body)) + body


def is_acknowledgement_of(received, packet_type, packet_id):
    received_type, body = received
    if received_type != packet_type or len(body) < PACKET_ID_LENGTH:
        return False
    return decode_unsigned_short(body[:PACKET_ID_LENGTH]) == packet_id


class MqttSession:
    """Holds messages that arrive mid-acknowledgement, so a handler cannot consume the outer ack."""

    def __init__(self, feed_watchdog, client_id, host, port, username, password, keepalive_seconds):
        self.feed_watchdog = feed_watchdog
        self.client_id = client_id
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.keepalive_seconds = keepalive_seconds
        self.socket_connection = None
        self.timeout_seconds = None
        self.last_will = None
        self.message_handler = None
        self.last_packet_id = 0
        self.unanswered_pings = 0
        self.deferred_messages = []
        self.is_awaiting_acknowledgement = False

    def set_last_will(self, topic, payload, is_retained, quality_of_service):
        self.last_will = (topic, payload, is_retained, quality_of_service)

    def set_message_handler(self, message_handler):
        self.message_handler = message_handler

    def connect(self, timeout_seconds):
        self.close()
        self.feed_watchdog()
        self.timeout_seconds = timeout_seconds
        self.socket_connection = socket.socket()
        self.socket_connection.settimeout(timeout_seconds)
        self.socket_connection.connect(socket.getaddrinfo(self.host, self.port)[0][-1])
        self.write(self.build_connect_packet())
        self.read_connack()

    def build_connect_packet(self):
        # Always clean: a persistent session is a queue of commands waiting to replay.
        flags = CLEAN_SESSION_FLAG
        payload = encode_string(self.client_id)
        if self.last_will is not None:
            topic, will_payload, is_retained, quality_of_service = self.last_will
            flags |= WILL_FLAG | quality_of_service << WILL_QOS_SHIFT
            if is_retained:
                flags |= WILL_RETAIN_FLAG
            payload += encode_string(topic) + encode_string(will_payload)
        if self.username:
            flags |= USERNAME_FLAG | PASSWORD_FLAG
            payload += encode_string(self.username) + encode_string(self.password)
        variable_header = (
            PROTOCOL_NAME_AND_LEVEL + bytes((flags,)) + encode_unsigned_short(self.keepalive_seconds)
        )
        return build_packet(CONNECT, variable_header + payload)

    def read_connack(self):
        packet_type, length, _session_present, return_code = struct.unpack(
            FOUR_UNSIGNED_BYTES, self.read(CONNACK_PACKET_LENGTH)
        )
        if packet_type != CONNACK or length != CONNACK_LENGTH:
            raise MqttError("expected CONNACK, got packet type 0x%02x" % packet_type)
        if return_code != CONNECTION_ACCEPTED:
            raise MqttError("connection refused with return code %d" % return_code)

    def subscribe(self, topic, quality_of_service):
        packet_id = self.next_packet_id()
        body = encode_unsigned_short(packet_id) + encode_string(topic) + bytes((quality_of_service,))
        self.write(build_packet(SUBSCRIBE, body))
        acknowledgement = self.wait_for_acknowledgement(SUBACK, packet_id)
        if acknowledgement[PACKET_ID_LENGTH] == SUBSCRIPTION_REFUSED:
            raise MqttError("subscription to %s refused" % topic)

    def publish(self, topic, payload, is_retained, quality_of_service):
        if quality_of_service > HIGHEST_SUPPORTED_QOS:
            raise MqttError("QoS %d is not supported" % quality_of_service)
        first_byte = PUBLISH | quality_of_service << QOS_SHIFT | (RETAIN_FLAG if is_retained else 0)
        body = encode_string(topic)
        packet_id = None
        if quality_of_service > 0:
            packet_id = self.next_packet_id()
            body += encode_unsigned_short(packet_id)
        self.write(build_packet(first_byte, body + encode_bytes(payload)))
        if packet_id is not None:
            self.wait_for_acknowledgement(PUBACK, packet_id)

    def ping(self):
        self.unanswered_pings += 1
        self.write(build_packet(PINGREQ, b""))

    def serve_one_message(self):
        if self.deferred_messages:
            self.message_handler(*self.deferred_messages.pop(0))
            return True
        self.socket_connection.setblocking(False)
        return self.receive_packet() is not None

    def take_deferred_messages(self):
        deferred_messages = self.deferred_messages
        self.deferred_messages = []
        return deferred_messages

    def close(self):
        if self.socket_connection is None:
            return
        try:  # noqa: SIM105 - MicroPython has no contextlib.suppress
            self.socket_connection.close()
        except OSError:
            pass
        self.socket_connection = None

    def next_packet_id(self):
        self.last_packet_id = self.last_packet_id % HIGHEST_PACKET_ID + 1
        return self.last_packet_id

    def wait_for_acknowledgement(self, packet_type, packet_id):
        was_awaiting = self.is_awaiting_acknowledgement
        self.is_awaiting_acknowledgement = True
        try:
            while True:
                received = self.receive_packet()
                if received is not None and is_acknowledgement_of(received, packet_type, packet_id):
                    _received_type, body = received
                    return body
        finally:
            self.is_awaiting_acknowledgement = was_awaiting

    def receive_packet(self):
        self.feed_watchdog()
        first_byte = self.socket_connection.read(SINGLE_BYTE)
        # A non-blocking check would otherwise leave the rest of the packet with no time limit.
        self.socket_connection.settimeout(self.timeout_seconds)
        if first_byte is None:
            return None
        if first_byte == b"":
            raise MqttError("the broker closed the connection")
        packet_type = first_byte[0]
        remaining_length = self.read_remaining_length()
        if packet_type & PACKET_TYPE_MASK == PUBLISH:
            self.receive_publish(packet_type, remaining_length)
            return (packet_type, b"")
        body = self.read(remaining_length) if remaining_length else b""
        if packet_type == PINGRESP:
            self.unanswered_pings = 0
        return (packet_type, body)

    def receive_publish(self, first_byte, remaining_length):
        topic_length = decode_unsigned_short(self.read(STRING_LENGTH_PREFIX))
        topic = self.read(topic_length)
        remaining_length -= STRING_LENGTH_PREFIX + topic_length
        quality_of_service = (first_byte & QOS_MASK) >> QOS_SHIFT
        if quality_of_service > 0:
            packet_id_bytes = self.read(PACKET_ID_LENGTH)
            remaining_length -= PACKET_ID_LENGTH
        payload = self.read(remaining_length) if remaining_length else b""
        if quality_of_service > 0:
            # Acknowledged before handling, because a handler may close this connection.
            self.write(build_packet(PUBACK, packet_id_bytes))
        self.deliver(topic, payload, bool(first_byte & RETAIN_FLAG))

    def deliver(self, topic, payload, is_retained):
        if self.is_awaiting_acknowledgement:
            self.deferred_messages.append((topic, payload, is_retained))
            return
        self.message_handler(topic, payload, is_retained)

    def read_remaining_length(self):
        length = 0
        shift = 0
        while True:
            digit = self.read(SINGLE_BYTE)[0]
            length |= (digit & LENGTH_DIGIT_MASK) << shift
            if not digit & LENGTH_CONTINUES:
                return length
            shift += LENGTH_DIGIT_BITS

    def read(self, size):
        received = self.socket_connection.read(size)
        if not received or len(received) != size:
            raise MqttError("short read: wanted %d bytes" % size)
        return received

    def write(self, packet):
        self.socket_connection.write(packet)
