import {
  MQTT_SCHEMAS,
  NodeKind,
  type GpioResultPayload,
} from '@tempestas/domain';
import {
  buildGpioSet,
  buildGpioSync,
  buildStatus,
  decodeAlarm,
  decodeGpioState,
  decodeHello,
  decodeResult,
  decodeSample,
  decodeStatus,
  parseJson,
  parseNodeTopic,
  verifyResult,
} from './mqtt-codec';
import type { PinCommand } from './hardware.service';

const NOW = new Date('2026-01-10T12:00:00Z');

function measurement(value: number | null, valid = value !== null) {
  return { value, valid, unit: 'x' };
}

function samplePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: MQTT_SCHEMAS.sample,
    node: 'elantris',
    ts: '2026-01-10T11:59:59Z',
    seq: 42,
    sensor: 'scd4x-0',
    measurements: {
      co2Ppm: measurement(812),
      tempC: measurement(21.5),
      humidityPct: measurement(55.2),
    },
    sensorStatus: { ok: true, consecutiveFailures: 0, lastSuccessTs: null },
    ...overrides,
  } as Record<string, unknown>;
}

function helloPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: MQTT_SCHEMAS.hello,
    node: 'elantris',
    ts: '2026-01-10T11:59:59Z',
    kind: NodeKind.RaspberryPi,
    agentVersion: '1.0.0',
    bootId: 'boot-1',
    capabilities: {
      contractVersion: 1,
      gpio: { pins: [16], supportsReadback: true },
      sensors: [],
      hasRtc: true,
    },
    ...overrides,
  } as Record<string, unknown>;
}

describe('parseNodeTopic', () => {
  it.each([
    ['tempestas/v1/node/elantris/hello', 'hello'],
    ['tempestas/v1/node/elantris/status', 'status'],
    ['tempestas/v1/node/elantris/gpio/set', 'gpio-set'],
    ['tempestas/v1/node/elantris/gpio/sync', 'gpio-sync'],
    ['tempestas/v1/node/elantris/gpio/result', 'gpio-result'],
    ['tempestas/v1/node/elantris/control/heartbeat', 'heartbeat'],
    ['tempestas/v1/node/elantris/alarm', 'alarm'],
  ])('parses %s as %s', (topic, kind) => {
    expect(parseNodeTopic(topic)).toEqual({ nodeId: 'elantris', kind });
  });

  it('parses a sensor sample and keeps the sensor id', () => {
    expect(
      parseNodeTopic('tempestas/v1/node/elantris/sensor/scd4x-0/sample'),
    ).toEqual({
      nodeId: 'elantris',
      kind: 'sample',
      sensorId: 'scd4x-0',
    });
  });

  it('parses a per-pin state topic and keeps the pin as a number', () => {
    expect(parseNodeTopic('tempestas/v1/node/elantris/gpio/state/16')).toEqual({
      nodeId: 'elantris',
      kind: 'gpio-state',
      pin: 16,
    });
  });

  it('ignores anything outside the node tree, including the server status', () => {
    expect(parseNodeTopic('tempestas/v1/server/status')).toBeNull();
    expect(parseNodeTopic('some/other/topic')).toBeNull();
    expect(parseNodeTopic('tempestas/v1/node/elantris')).toBeNull();
  });

  it('reports an unrecognised subtopic as unknown rather than guessing', () => {
    expect(
      parseNodeTopic('tempestas/v1/node/elantris/gpio/state/abc')?.kind,
    ).toBe('unknown');
    expect(
      parseNodeTopic('tempestas/v1/node/elantris/something/new')?.kind,
    ).toBe('unknown');
  });
});

describe('parseJson', () => {
  it('rejects a non-object, so a bare number cannot be treated as a payload', () => {
    expect(parseJson('42')).toMatchObject({ ok: false });
    expect(parseJson('[]')).toMatchObject({ ok: false });
    expect(parseJson('not json')).toMatchObject({ ok: false });
  });

  // This is how a retained message is deleted, not a fault.
  it('reports an empty payload distinctly, because that is a retained clear', () => {
    expect(parseJson('')).toEqual({ ok: false, reason: 'empty payload' });
  });
});

describe('schema majors', () => {
  it.each([['sample/2'], ['sample/0'], ['sample'], [''], [undefined], [7]])(
    'refuses schema %s rather than parsing hopefully',
    (schema) => {
      const decoded = decodeSample(
        samplePayload({ schema }),
        'elantris',
        'scd4x-0',
        NOW,
      );
      expect(decoded).toMatchObject({ ok: false });
    },
  );
});

describe('decodeSample', () => {
  it('server-stamps the receipt time and keeps the node seq', () => {
    const decoded = decodeSample(samplePayload(), 'elantris', 'scd4x-0', NOW);
    expect(decoded).toEqual({
      ok: true,
      value: {
        nodeId: 'elantris',
        sensorId: 'scd4x-0',
        receivedAt: NOW,
        temperature: 21.5,
        humidity: 55.2,
        co2: 812,
        nodeSeq: 42,
      },
    });
  });

  // An invalid CO2 is a legitimate, meaningful state - null, never zero - and
  // the burner's daytime branch fails safe on it.
  it('maps an invalid CO2 to null and keeps the sample', () => {
    const payload = samplePayload({
      measurements: {
        co2Ppm: {
          value: null,
          valid: false,
          unit: 'ppm',
          reason: 'ZERO_READING',
        },
        tempC: measurement(21.5),
        humidityPct: measurement(55.2),
      },
    });
    expect(decodeSample(payload, 'elantris', 'scd4x-0', NOW)).toMatchObject({
      ok: true,
      value: { co2: null, temperature: 21.5 },
    });
  });

  // Every rule reads temperature. A sample without it is not a partial reading,
  // it is nothing - and half-applying it would hand the engine a phantom value.
  it('drops a sample whose temperature is invalid', () => {
    const payload = samplePayload({
      measurements: {
        co2Ppm: measurement(812),
        tempC: { value: null, valid: false, unit: 'C' },
        humidityPct: measurement(55.2),
      },
    });
    expect(decodeSample(payload, 'elantris', 'scd4x-0', NOW)).toMatchObject({
      ok: false,
    });
  });

  it('drops a sample claiming valid with a non-finite value', () => {
    const payload = samplePayload({
      measurements: {
        co2Ppm: measurement(812),
        tempC: { value: Number.NaN, valid: true, unit: 'C' },
        humidityPct: measurement(55.2),
      },
    });
    expect(decodeSample(payload, 'elantris', 'scd4x-0', NOW)).toMatchObject({
      ok: false,
    });
  });

  it('drops a sample with no measurements at all', () => {
    expect(
      decodeSample(
        samplePayload({ measurements: undefined }),
        'elantris',
        'scd4x-0',
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('carries a null seq when the node sends none, rather than inventing one', () => {
    const decoded = decodeSample(
      samplePayload({ seq: undefined }),
      'elantris',
      'scd4x-0',
      NOW,
    );
    expect(decoded).toMatchObject({ ok: true, value: { nodeSeq: null } });
  });
});

describe('decodeHello', () => {
  it('accepts a well-formed hello', () => {
    expect(decodeHello(helloPayload(), 'elantris', NOW)).toMatchObject({
      ok: true,
      value: {
        nodeId: 'elantris',
        bootId: 'boot-1',
        kind: NodeKind.RaspberryPi,
      },
    });
  });

  // Without a bootId a reboot is undetectable and the reading dedupe loses its
  // scope, so it is not an optional field.
  it.each([[undefined], ['']])('refuses a hello with bootId %s', (bootId) => {
    expect(
      decodeHello(helloPayload({ bootId }), 'elantris', NOW),
    ).toMatchObject({ ok: false });
  });

  it('refuses a hello with no capabilities, or the wrong contract version', () => {
    expect(
      decodeHello(helloPayload({ capabilities: undefined }), 'elantris', NOW),
    ).toMatchObject({
      ok: false,
    });
    expect(
      decodeHello(
        helloPayload({
          capabilities: { contractVersion: 2, sensors: [], hasRtc: true },
        }),
        'elantris',
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });

  it('refuses a hello with no kind', () => {
    expect(
      decodeHello(helloPayload({ kind: undefined }), 'elantris', NOW),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('decodeStatus', () => {
  it.each([
    ['online', true],
    ['offline', false],
  ])('maps %s', (state, online) => {
    expect(
      decodeStatus(
        { schema: MQTT_SCHEMAS.status, node: 'elantris', ts: '', state },
        'elantris',
        NOW,
      ),
    ).toEqual({ ok: true, value: { nodeId: 'elantris', online, at: NOW } });
  });

  // Guessing either way is wrong: "stale is not off", and guessing online is
  // worse still.
  it('refuses an unknown state rather than defaulting', () => {
    expect(
      decodeStatus(
        {
          schema: MQTT_SCHEMAS.status,
          node: 'elantris',
          ts: '',
          state: 'maybe',
        },
        'elantris',
        NOW,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe('decodeGpioState', () => {
  const TS = '2026-09-10T20:50:00.000Z';

  it("records a known level and the node's own timestamp", () => {
    const raw = {
      schema: MQTT_SCHEMAS.gpioState,
      node: 'e',
      ts: TS,
      pin: 16,
      level: 0,
      known: true,
    };
    expect(decodeGpioState(raw, 16)).toEqual({
      ok: true,
      value: { pin: 16, level: 0, known: true, observedAt: new Date(TS) },
    });
  });

  // The node's timestamp ends up in a device's `offAt`, which decides when the
  // minimum-off window started. Defaulting a bad one to our clock would restart
  // a burner's cooldown from whenever we happened to receive the message, so it
  // is refused instead.
  it.each([
    ['', 'empty'],
    ['not-a-date', 'garbage'],
  ])('refuses an unparseable ts (%s)', (ts) => {
    const raw = {
      schema: MQTT_SCHEMAS.gpioState,
      node: 'e',
      ts,
      pin: 16,
      level: 0,
      known: true,
    };
    expect(decodeGpioState(raw, 16)).toMatchObject({
      ok: false,
      reason: /unparseable ts/,
    });
  });

  // `known: false` is a first-class state, not an error. Stale is not off.
  it('accepts an explicitly unknown line', () => {
    const raw = {
      schema: MQTT_SCHEMAS.gpioState,
      node: 'e',
      ts: TS,
      pin: 16,
      level: null,
      known: false,
    };
    expect(decodeGpioState(raw, 16)).toEqual({
      ok: true,
      value: {
        pin: 16,
        level: null,
        known: false,
        observedAt: new Date(TS),
      },
    });
  });

  it('refuses a line claiming to be known with no usable level', () => {
    const raw = {
      schema: MQTT_SCHEMAS.gpioState,
      node: 'e',
      ts: '',
      pin: 16,
      level: null,
      known: true,
    };
    expect(decodeGpioState(raw, 16)).toMatchObject({ ok: false });
  });
});

describe('verifyResult', () => {
  const requested: PinCommand[] = [{ pin: 16, level: 0 }];

  function result(
    overrides: Partial<GpioResultPayload> = {},
  ): GpioResultPayload {
    return {
      schema: MQTT_SCHEMAS.gpioResult,
      node: 'elantris',
      ts: '',
      id: 'cmd-1',
      ok: true,
      lines: [{ pin: 16, requested: 0, readback: 0, ok: true }],
      ...overrides,
    };
  }

  it('passes when every requested pin read back what was asked', () => {
    expect(verifyResult(result(), requested)).toBeNull();
  });

  // The old system logged a failed GPIO write and updated the row anyway, so
  // the UI showed a heater running when it was not.
  it('fails on a readback that disagrees with the command', () => {
    const mismatch = result({
      lines: [{ pin: 16, requested: 0, readback: 1, ok: true }],
    });
    expect(verifyResult(mismatch, requested)).toMatchObject({ ok: false });
  });

  // `null` means the node could not read the line back. Unknown state on a
  // burner relay is exactly what must not be believed.
  it('fails on an unknown readback, even when the node says ok', () => {
    const unknown = result({
      lines: [{ pin: 16, requested: 0, readback: null, ok: true }],
    });
    expect(verifyResult(unknown, requested)).toMatchObject({ ok: false });
  });

  it('fails when the node reports overall failure', () => {
    const failed = result({
      ok: false,
      lines: [
        {
          pin: 16,
          requested: 0,
          readback: null,
          ok: false,
          error: 'GPIO_LINE_BUSY',
        },
      ],
    });
    expect(verifyResult(failed, requested)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('GPIO_LINE_BUSY'),
    });
  });

  it('fails when a requested pin is missing from the result entirely', () => {
    const other = result({
      lines: [{ pin: 20, requested: 0, readback: 0, ok: true }],
    });
    expect(verifyResult(other, requested)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no result for pin 16'),
    });
  });
});

describe('builders', () => {
  it('stamps every command with an expiry', () => {
    const payload = buildGpioSet(
      { nodeId: 'elantris', now: NOW },
      'cmd-1',
      'ctl',
      [{ pin: 16, level: 0 }],
      15_000,
    );
    expect(payload).toMatchObject({
      schema: MQTT_SCHEMAS.gpioSet,
      node: 'elantris',
      id: 'cmd-1',
      issuedBy: 'ctl',
      expiresAt: '2026-01-10T12:00:15.000Z',
      lines: [{ pin: 16, level: 0 }],
    });
  });

  it('carries the controller and epoch on a sync, so a takeover is detectable', () => {
    const payload = buildGpioSync(
      { nodeId: 'elantris', now: NOW },
      'ctl',
      99,
      [],
      false,
    );
    expect(payload).toMatchObject({
      controller: 'ctl',
      epoch: 99,
      dryRun: false,
      intent: [],
    });
  });

  it('builds the server status the LWT uses', () => {
    expect(buildStatus('server', 'offline', NOW)).toEqual({
      schema: MQTT_SCHEMAS.status,
      node: 'server',
      ts: NOW.toISOString(),
      state: 'offline',
    });
  });
});

describe('decodeAlarm', () => {
  it('accepts a well-formed alarm', () => {
    const raw = {
      schema: MQTT_SCHEMAS.alarm,
      node: 'elantris',
      ts: '',
      code: 'DEADMAN_TRIPPED',
      severity: 'critical',
      message: 'no heartbeat',
    };
    expect(decodeAlarm(raw)).toMatchObject({
      ok: true,
      value: { code: 'DEADMAN_TRIPPED' },
    });
  });

  it('refuses an alarm with no code or message', () => {
    expect(
      decodeAlarm({
        schema: MQTT_SCHEMAS.alarm,
        node: 'e',
        ts: '',
        severity: 'info',
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('decodeResult', () => {
  it('refuses a result with no id or lines', () => {
    expect(
      decodeResult({ schema: MQTT_SCHEMAS.gpioResult, node: 'e', ts: '' }),
    ).toMatchObject({
      ok: false,
    });
  });
});
