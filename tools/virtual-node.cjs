// A virtual node: ~60 lines that speak the whole MQTT contract.
//
// This exists because the contract is deliberately plain JSON on plain topics -
// if a script this size cannot speak it, a 60-line Python sidecar on an ESP32
// cannot either. It is the harness for the phase 7 checkpoint, and it stays
// useful afterwards for exercising the server with no hardware present.
//
//   node tools/virtual-node.cjs <slug> <tempC> <seconds>
//
// It publishes a retained `status: online`, a `hello` advertising five GPIO pins
// and one SCD4x, then a sample every 10s. It answers `gpio/set` with a matching
// `gpio/result` and a retained `gpio/state`, and it implements the three guards
// a real agent must: drop a retained command, refuse an expired one, and ignore
// an empty payload (which is how a retained command is cleared).
//
// Kill it with `kill -9` to see its last will fire. A clean exit deliberately
// does NOT fire the will - MQTT suppresses it on a graceful DISCONNECT - which
// is why a real agent must publish `status: offline` itself on shutdown.

const { connect } = require('mqtt');
const ROOT = 'tempestas/v1';
const slug = process.argv[2] || 'bench-pi';
const tempC = Number(process.argv[3] ?? 2);
const seconds = Number(process.argv[4] ?? 40);
const now = () => new Date().toISOString();
const log = (m) => console.log(`${now().slice(11, 19)} [${slug}] ${m}`);
const bootId = `boot-${Date.now()}`;
const state = {};
let seq = 0;

const client = connect('mqtt://127.0.0.1:1883', {
  clientId: `vnode-${slug}`,
  clean: true,
  will: {
    topic: `${ROOT}/node/${slug}/status`,
    payload: JSON.stringify({
      schema: 'status/1',
      node: slug,
      ts: now(),
      state: 'offline',
    }),
    qos: 1,
    retain: true,
  },
});

const pub = (t, p, o = { qos: 1, retain: false }) =>
  client.publish(t, JSON.stringify(p), o);

function sample() {
  seq += 1;
  pub(
    `${ROOT}/node/${slug}/sensor/scd4x-v/sample`,
    {
      schema: 'sample/1',
      node: slug,
      ts: now(),
      seq,
      sensor: 'scd4x-v',
      measurements: {
        co2Ppm: { value: 800, valid: true, unit: 'ppm' },
        tempC: { value: tempC, valid: true, unit: 'C' },
        humidityPct: { value: 55, valid: true, unit: '%' },
      },
      sensorStatus: { ok: true, consecutiveFailures: 0, lastSuccessTs: now() },
    },
    { qos: 0, retain: false },
  );
  log(`published sample seq=${seq} ${tempC}C`);
}

client.on('connect', () => {
  log('connected');
  pub(
    `${ROOT}/node/${slug}/status`,
    { schema: 'status/1', node: slug, ts: now(), state: 'online' },
    { qos: 1, retain: true },
  );
  pub(`${ROOT}/node/${slug}/hello`, {
    schema: 'hello/1',
    node: slug,
    ts: now(),
    kind: 'rpi',
    agentVersion: '0.0.1-virtual',
    bootId,
    capabilities: {
      contractVersion: 1,
      gpio: { pins: [12, 16, 20, 21, 26], supportsReadback: true },
      sensors: [
        {
          sensorId: 'scd4x-v',
          kind: 'scd4x',
          metrics: ['temperature', 'humidity', 'co2'],
          sampleIntervalMs: 10000,
        },
      ],
      hasRtc: true,
    },
  });
  client.subscribe(
    [
      `${ROOT}/node/${slug}/gpio/set`,
      `${ROOT}/node/${slug}/gpio/sync`,
      `${ROOT}/node/${slug}/control/heartbeat`,
    ],
    { qos: 1 },
  );
  sample();
  setInterval(sample, 10000);
});

client.on('message', (topic, buf, packet) => {
  if (topic.endsWith('/control/heartbeat')) return;

  if (topic.endsWith('/gpio/set')) {
    // Guard 1: a retained command replays on every reconnect. Drop and alarm.
    if (packet.retain) {
      log('RETAINED_COMMAND_DROPPED');
      pub(`${ROOT}/node/${slug}/alarm`, {
        schema: 'alarm/1',
        node: slug,
        ts: now(),
        code: 'RETAINED_COMMAND_DROPPED',
        severity: 'critical',
        message: 'inbound command carried the retain flag',
      });
      return;
    }
    // A zero-length payload is how a retained command is CLEARED. Ignore it
    // rather than parsing it - required agent behaviour, see the contract.
    if (buf.toString().trim() === '') {
      log('ignored an empty (cleared) command');
      return;
    }
    const cmd = JSON.parse(buf.toString());
    // Guard 2: every command expires.
    if (new Date(cmd.expiresAt).getTime() < Date.now()) {
      log(`COMMAND_EXPIRED ${cmd.id}`);
      pub(`${ROOT}/node/${slug}/alarm`, {
        schema: 'alarm/1',
        node: slug,
        ts: now(),
        code: 'COMMAND_EXPIRED',
        severity: 'warning',
        message: cmd.id,
      });
      return;
    }
    const lines = cmd.lines.map((l) => {
      state[l.pin] = l.level;
      return { pin: l.pin, requested: l.level, readback: l.level, ok: true };
    });
    pub(`${ROOT}/node/${slug}/gpio/result`, {
      schema: 'gpioResult/1',
      node: slug,
      ts: now(),
      id: cmd.id,
      ok: true,
      lines,
    });
    for (const l of cmd.lines) {
      pub(
        `${ROOT}/node/${slug}/gpio/state/${l.pin}`,
        {
          schema: 'gpioState/1',
          node: slug,
          ts: now(),
          pin: l.pin,
          level: l.level,
          known: true,
        },
        { qos: 1, retain: true },
      );
    }
    log(
      `applied ${JSON.stringify(cmd.lines)} for ${cmd.id}, acked with readback`,
    );
  }
});

setTimeout(() => {
  log('leaving (LWT should fire)');
  client.end(false, () => process.exit(0));
}, seconds * 1000);
