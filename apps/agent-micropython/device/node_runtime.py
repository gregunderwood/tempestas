"""Any hang ends in a watchdog reset, which releases every pin: the failsafe."""

import binascii
import json
import os
import time

import ds18x20
import machine
import network
import ntptime
import onewire

import board
import contract
import credentials
import settings
from ds18b20_probes import Ds18b20Probes
from node_agent import NodeAgent
from relay_lines import ReleasedWhenHighLines
from tempestas_mqtt import MqttSession

WATCHDOG_TIMEOUT_MILLISECONDS = 8000
LOOP_PAUSE_MILLISECONDS = 100
WIFI_JOIN_LIMIT_MILLISECONDS = 20000
WIFI_POLL_MILLISECONDS = 250
RECONNECT_AFTER_MILLISECONDS = 15000
CLOCK_RESYNC_AFTER_MILLISECONDS = 3600000
CLOCK_RETRY_AFTER_MILLISECONDS = 60000
# Connect and CONNACK each wait this long, back to back, inside the 8 s watchdog.
SOCKET_TIMEOUT_SECONDS = 3
UNANSWERED_PINGS_BEFORE_DROPPING = 2
MILLISECONDS_PER_SECOND = 1000
BOOT_ID_BYTES = 6
MAX_MESSAGES_HELD_OFFLINE = 20
PINGS_PER_KEEPALIVE = 2


def log(message):
    print(message)


class TicksClock:
    def ticks(self):
        return time.ticks_ms()

    def elapsed_since(self, earlier_ticks):
        return time.ticks_diff(time.ticks_ms(), earlier_ticks)

    def epoch_seconds(self):
        return time.time()


class BrokerPublisher:
    """Publishes while connected and drops while not; the dead-man and failsafe never wait on it."""

    def __init__(self):
        self.client = None
        self.held_messages = []
        self.undelivered_messages = []

    def publish(self, topic, text, is_retained, quality_of_service, should_hold_while_offline):
        message = (topic, text, is_retained, quality_of_service)
        if self.client is not None and self.try_publishing(message):
            return
        if should_hold_while_offline:
            self.hold(message)

    def try_publishing(self, message):
        try:
            self.client.publish(*message)
        except Exception as error:
            self.drop("publish failed: %r" % error)
            return False
        return True

    def hold(self, message):
        self.held_messages.append(message)
        if len(self.held_messages) > MAX_MESSAGES_HELD_OFFLINE:
            self.held_messages.pop(0)

    def send_held_messages(self):
        held_messages = self.held_messages
        self.held_messages = []
        for topic, text, is_retained, quality_of_service in held_messages:
            self.publish(topic, text, is_retained, quality_of_service, True)

    def take_undelivered_messages(self):
        undelivered_messages = self.undelivered_messages
        self.undelivered_messages = []
        return undelivered_messages

    def drop(self, reason):
        log("dropping the broker connection: %s" % reason)
        if self.client is None:
            return
        # Already acknowledged to the broker, so it will never send these again.
        self.undelivered_messages.extend(self.client.take_deferred_messages())
        self.client.close()
        self.client = None


class Connection:
    def __init__(self, watchdog, clock, agent, publisher):
        self.watchdog = watchdog
        self.clock = clock
        self.agent = agent
        self.publisher = publisher
        self.wifi = network.WLAN(network.STA_IF)
        self.last_attempt_ticks = None
        self.last_clock_attempt_ticks = None
        self.is_clock_synced = False
        self.last_ping_ticks = None

    def keep_up(self):
        if self.publisher.client is not None:
            # Spacing applies to failed attempts only, and a stale stamp would wrap after 6 days.
            self.last_attempt_ticks = None
            return
        if (
            self.last_attempt_ticks is not None
            and self.clock.elapsed_since(self.last_attempt_ticks) < RECONNECT_AFTER_MILLISECONDS
        ):
            return
        self.last_attempt_ticks = self.clock.ticks()
        if not self.join_wifi():
            return
        self.sync_clock_when_due()
        self.connect_to_broker()

    def join_wifi(self):
        if self.wifi.isconnected():
            return True
        self.wifi.active(True)
        board.keep_wifi_awake(self.wifi)
        self.wifi.connect(credentials.WIFI_SSID, credentials.WIFI_PASSWORD)
        started_ticks = self.clock.ticks()
        while self.clock.elapsed_since(started_ticks) < WIFI_JOIN_LIMIT_MILLISECONDS:
            self.watchdog.feed()
            if self.wifi.isconnected():
                log("wifi joined at %s" % self.wifi.ifconfig()[0])
                return True
            time.sleep_ms(WIFI_POLL_MILLISECONDS)
        log("wifi did not join; will retry")
        return False

    def resync_clock_while_online(self):
        if not self.wifi.isconnected():
            # Offline for days would wrap the stamp, so sync afresh as soon as Wi-Fi returns.
            self.last_clock_attempt_ticks = None
            return
        self.sync_clock_when_due()

    def sync_clock_when_due(self):
        if not self.is_clock_sync_due():
            return
        self.last_clock_attempt_ticks = self.clock.ticks()
        self.watchdog.feed()
        try:
            ntptime.settime()
            self.is_clock_synced = True
            log("clock set from NTP")
            self.agent.on_clock_set()
        except Exception as error:
            log("NTP failed: %r" % error)

    def is_clock_sync_due(self):
        if self.last_clock_attempt_ticks is None:
            return True
        wait_milliseconds = (
            CLOCK_RESYNC_AFTER_MILLISECONDS if self.is_clock_synced else CLOCK_RETRY_AFTER_MILLISECONDS
        )
        return self.clock.elapsed_since(self.last_clock_attempt_ticks) >= wait_milliseconds

    def connect_to_broker(self):
        node_id = settings.NODE_ID
        client = MqttSession(
            self.watchdog.feed,
            "tempestas-" + node_id,
            settings.BROKER_HOST,
            settings.BROKER_PORT,
            credentials.MQTT_USERNAME,
            credentials.MQTT_PASSWORD,
            settings.KEEPALIVE_SECONDS,
        )
        quality_of_service, is_retained = contract.QOS["status"]
        offline = json.dumps(self.agent.build_status_payload("offline"))
        client.set_last_will(contract.build_status_topic(node_id), offline, is_retained, quality_of_service)
        client.set_message_handler(self.deliver)
        try:
            client.connect(SOCKET_TIMEOUT_SECONDS)
            for topic, subscription_quality_of_service in self.agent.list_subscriptions():
                client.subscribe(topic, subscription_quality_of_service)
        except Exception as error:
            log("broker connect failed: %r" % error)
            client.close()
            return
        log("connected to %s as %s" % (settings.BROKER_HOST, node_id))
        self.publisher.client = client
        self.last_ping_ticks = self.clock.ticks()
        self.agent.announce()
        self.publisher.send_held_messages()

    def deliver(self, topic, payload, is_retained):
        try:
            self.agent.on_message(topic.decode(), payload, is_retained)
        except Exception as error:
            log("a message on %s could not be handled: %r" % (topic, error))

    def serve_pending_messages(self):
        self.deliver_undelivered_messages()
        client = self.publisher.client
        if client is None:
            return
        if not self.wifi.isconnected():
            self.publisher.drop("wifi lost")
            return
        if client.unanswered_pings >= UNANSWERED_PINGS_BEFORE_DROPPING:
            self.publisher.drop("broker stopped answering pings")
            return
        try:
            while self.publisher.client is client and client.serve_one_message():
                self.watchdog.feed()
            if self.publisher.client is client:
                self.ping_when_due(client)
        except Exception as error:
            # A handler may already have dropped this client; the tail of its message then fails too.
            if self.publisher.client is client:
                self.publisher.drop("connection lost: %r" % error)

    def deliver_undelivered_messages(self):
        for topic, payload, is_retained in self.publisher.take_undelivered_messages():
            self.deliver(topic, payload, is_retained)

    def ping_when_due(self, client):
        keepalive_milliseconds = settings.KEEPALIVE_SECONDS * MILLISECONDS_PER_SECOND
        ping_interval_milliseconds = keepalive_milliseconds // PINGS_PER_KEEPALIVE
        if self.clock.elapsed_since(self.last_ping_ticks) >= ping_interval_milliseconds:
            client.ping()
            self.last_ping_ticks = self.clock.ticks()


def build_probes():
    bus = onewire.OneWire(machine.Pin(settings.ONE_WIRE_PIN))
    return Ds18b20Probes(ds18x20.DS18X20(bus), settings.PROBES, time.sleep_ms, log)


def build_boot_id():
    return "boot-" + binascii.hexlify(os.urandom(BOOT_ID_BYTES)).decode()


def run():
    watchdog = machine.WDT(timeout=WATCHDOG_TIMEOUT_MILLISECONDS)
    relay_lines = ReleasedWhenHighLines(machine, board, settings.RELAY_LINES, settings.FAILSAFE_LEVELS)
    relay_lines.claim_at_failsafe()

    probes = build_probes()
    probes.start()
    clock = TicksClock()
    publisher = BrokerPublisher()
    agent = NodeAgent(settings, publisher, relay_lines, probes, clock, log, build_boot_id())
    connection = Connection(watchdog, clock, agent, publisher)

    sample_interval_milliseconds = settings.SAMPLE_INTERVAL_SECONDS * MILLISECONDS_PER_SECOND
    last_sample_ticks = None
    while True:
        watchdog.feed()
        connection.keep_up()
        connection.resync_clock_while_online()
        connection.serve_pending_messages()
        is_sample_due = (
            last_sample_ticks is None
            or clock.elapsed_since(last_sample_ticks) >= sample_interval_milliseconds
        )
        if is_sample_due:
            last_sample_ticks = clock.ticks()
            agent.publish_readings()
        agent.check_deadman()
        time.sleep_ms(LOOP_PAUSE_MILLISECONDS)
