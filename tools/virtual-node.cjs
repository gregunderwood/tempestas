// A node in a few dozen lines, proof the contract is plain enough for an ESP32 sidecar to speak.
//   node tools/virtual-node.cjs <slug> <tempC> <seconds>
// Kill it with `kill -9` to see its last will fire; a clean exit fires none, by MQTT design.

const { connect } = require('mqtt');

const ROOT = 'tempestas/v1';
const BROKER_URL = 'mqtt://127.0.0.1:1883';
const SENSOR_ID = 'scd4x-v';
const SAMPLE_INTERVAL_MS = 10000;
const ADVERTISED_PINS = [12, 16, 20, 21, 26];
const RELIABLE = { qos: 1, retain: false };
const RETAINED = { qos: 1, retain: true };
const FIRE_AND_FORGET = { qos: 0, retain: false };

const slug = process.argv[2] || 'bench-pi';
const tempC = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 40);
const bootId = `boot-${Date.now()}`;
const nodeTopic = `${ROOT}/node/${slug}`;
const levelsByPin = {};
let sequence = 0;

const now = () => new Date().toISOString();
const log = (message) =>
  console.log(`${now().slice(11, 19)} [${slug}] ${message}`);

const client = connect(BROKER_URL, {
  clientId: `vnode-${slug}`,
  clean: true,
  will: {
    topic: `${nodeTopic}/status`,
    payload: JSON.stringify({
      schema: 'status/1',
      node: slug,
      ts: now(),
      state: 'offline',
    }),
    ...RETAINED,
  },
});

const publish = (topic, payload, options = RELIABLE) =>
  client.publish(topic, JSON.stringify(payload), options);

function publishAlarm(code, severity, message) {
  publish(`${nodeTopic}/alarm`, {
    schema: 'alarm/1',
    node: slug,
    ts: now(),
    code,
    severity,
    message,
  });
}

function publishSample() {
  sequence += 1;
  publish(
    `${nodeTopic}/sensor/${SENSOR_ID}/sample`,
    {
      schema: 'sample/1',
      node: slug,
      ts: now(),
      seq: sequence,
      sensor: SENSOR_ID,
      measurements: {
        co2Ppm: { value: 800, valid: true, unit: 'ppm' },
        tempC: { value: tempC, valid: true, unit: 'C' },
        humidityPct: { value: 55, valid: true, unit: '%' },
      },
      sensorStatus: { ok: true, consecutiveFailures: 0, lastSuccessTs: now() },
    },
    FIRE_AND_FORGET,
  );
  log(`published sample seq=${sequence} ${tempC}C`);
}

function announce() {
  publish(
    `${nodeTopic}/status`,
    { schema: 'status/1', node: slug, ts: now(), state: 'online' },
    RETAINED,
  );
  publish(`${nodeTopic}/hello`, {
    schema: 'hello/1',
    node: slug,
    ts: now(),
    kind: 'rpi',
    agentVersion: '0.0.1-virtual',
    bootId,
    capabilities: {
      contractVersion: 1,
      gpio: { pins: ADVERTISED_PINS, supportsReadback: true },
      sensors: [
        {
          sensorId: SENSOR_ID,
          kind: 'scd4x',
          metrics: ['temperature', 'humidity', 'co2'],
          sampleIntervalMs: SAMPLE_INTERVAL_MS,
        },
      ],
      hasRtc: true,
    },
  });
}

const isExpired = (command) =>
  new Date(command.expiresAt).getTime() < Date.now();

function applyCommand(command) {
  const results = command.lines.map((line) => {
    levelsByPin[line.pin] = line.level;
    return {
      pin: line.pin,
      requested: line.level,
      readback: line.level,
      ok: true,
    };
  });
  publish(`${nodeTopic}/gpio/result`, {
    schema: 'gpioResult/1',
    node: slug,
    ts: now(),
    id: command.id,
    ok: true,
    lines: results,
  });
  for (const line of command.lines) {
    publish(
      `${nodeTopic}/gpio/state/${line.pin}`,
      {
        schema: 'gpioState/1',
        node: slug,
        ts: now(),
        pin: line.pin,
        level: line.level,
        known: true,
      },
      RETAINED,
    );
  }
  log(
    `applied ${JSON.stringify(command.lines)} for ${command.id}, acked with readback`,
  );
}

function handleGpioSet(payload, packet) {
  // A retained command replays on every reconnect.
  if (packet.retain) {
    log('RETAINED_COMMAND_DROPPED');
    publishAlarm(
      'RETAINED_COMMAND_DROPPED',
      'critical',
      'inbound command carried the retain flag',
    );
    return;
  }
  // An empty payload is how a retained command is cleared.
  if (payload.toString().trim() === '') {
    log('ignored an empty (cleared) command');
    return;
  }
  const command = JSON.parse(payload.toString());
  if (isExpired(command)) {
    log(`COMMAND_EXPIRED ${command.id}`);
    publishAlarm('COMMAND_EXPIRED', 'warning', command.id);
    return;
  }
  applyCommand(command);
}

client.on('connect', () => {
  log('connected');
  announce();
  client.subscribe(
    [
      `${nodeTopic}/gpio/set`,
      `${nodeTopic}/gpio/sync`,
      `${nodeTopic}/control/heartbeat`,
    ],
    { qos: 1 },
  );
  publishSample();
  setInterval(publishSample, SAMPLE_INTERVAL_MS);
});

client.on('message', (topic, payload, packet) => {
  if (topic.endsWith('/gpio/set')) handleGpioSet(payload, packet);
});

setTimeout(() => {
  log('leaving (LWT should fire)');
  client.end(false, () => process.exit(0));
}, seconds * 1000);
