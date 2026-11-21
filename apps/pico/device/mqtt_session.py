"""Holds messages that arrive mid-publish, so a handler cannot steal the publish's PUBACK."""

from tempestas_mqtt import MQTTClient

PUBLISH_OPERATION = 0x30


class DeferringMqttClient(MQTTClient):
    def __init__(self, feed_watchdog, *arguments, **keyword_arguments):
        super().__init__(*arguments, **keyword_arguments)
        self.feed_watchdog = feed_watchdog
        self.deferred_messages = []
        self.is_awaiting_acknowledgement = False
        self.message_handler = None

    def set_message_handler(self, message_handler):
        self.message_handler = message_handler
        self.set_callback(self.receive)

    def receive(self, topic, payload, is_retained):
        if self.is_awaiting_acknowledgement:
            self.deferred_messages.append((topic, payload, is_retained))
            return
        self.message_handler(topic, payload, is_retained)

    def publish(self, topic, payload, retain=False, qos=0):
        self.await_acknowledgement(super().publish, topic, payload, retain, qos)

    def _send_subunsub(self, *arguments):
        self.await_acknowledgement(super()._send_subunsub, *arguments)

    def await_acknowledgement(self, send, *arguments):
        was_awaiting = self.is_awaiting_acknowledgement
        self.is_awaiting_acknowledgement = True
        try:
            send(*arguments)
        finally:
            self.is_awaiting_acknowledgement = was_awaiting

    def connect(self, clean_session=True, timeout=None):
        self.feed_watchdog()
        return super().connect(clean_session, timeout)

    def wait_msg(self):
        # Each wait can block for the socket timeout, so a chain of them must not starve the watchdog.
        self.feed_watchdog()
        return super().wait_msg()

    def ping(self):
        self.unanswered_pings += 1
        super().ping()

    def check_msg(self):
        if not self.deferred_messages:
            return super().check_msg()
        topic, payload, is_retained = self.deferred_messages.pop(0)
        self.message_handler(topic, payload, is_retained)
        return PUBLISH_OPERATION

    def close(self):
        if self.sock is None:
            return
        try:  # noqa: SIM105 - MicroPython has no contextlib.suppress
            self.sock.close()
        except OSError:
            pass
        self.sock = None
