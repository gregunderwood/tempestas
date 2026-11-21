import {
  AgentApp,
  AlarmCode,
  MQTT_SCHEMAS,
  mqttQos,
  mqttTopics,
  UpdateState,
} from './mqtt-contract';
import {
  isUpdateStatusPayload,
  judgeUpdateCommand,
  readVersionMajor,
  type UpdateCommandContext,
} from './update-command';

const SERVER = 'tempestas-server';
const NOW = new Date('2026-11-21T12:00:00Z');
const MANIFEST_SHA256 = 'a'.repeat(64);

function buildUpdate(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: MQTT_SCHEMAS.update,
    node: 'patji',
    ts: NOW.toISOString(),
    id: 'update-1',
    issuedBy: SERVER,
    expiresAt: '2026-11-21T12:05:00Z',
    app: AgentApp.Linux,
    version: '1.1.4',
    manifestUrl:
      'http://elantris.local:7000/api/bundles/agent-linux/1.1.4/manifest.json',
    manifestSha256: MANIFEST_SHA256,
    ...overrides,
  });
}

function buildContext(
  overrides: Partial<UpdateCommandContext> = {},
): UpdateCommandContext {
  return {
    isRetained: false,
    boundController: SERVER,
    runningApp: AgentApp.Linux,
    now: NOW,
    ...overrides,
  };
}

describe('the update topics', () => {
  it('sit under the node, beside gpio', () => {
    expect(mqttTopics.update('patji')).toBe('tempestas/v1/node/patji/update');
    expect(mqttTopics.updateStatus('patji')).toBe(
      'tempestas/v1/node/patji/update/status',
    );
  });

  it('are never retained', () => {
    expect(mqttQos.update).toEqual({ qos: 1, retain: false });
    expect(mqttQos.updateStatus).toEqual({ qos: 1, retain: false });
  });
});

describe('judgeUpdateCommand', () => {
  it('accepts a fresh update from the bound controller for this app', () => {
    const verdict = judgeUpdateCommand(buildUpdate(), buildContext());

    expect(verdict.isAccepted).toBe(true);
    expect(verdict.isAccepted && verdict.command.version).toBe('1.1.4');
  });

  it('ignores an empty payload without alarming, since that is a retained clear', () => {
    expect(judgeUpdateCommand('  ', buildContext())).toMatchObject({
      isAccepted: false,
      answer: 'log',
    });
  });

  it('drops a retained update and alarms', () => {
    expect(
      judgeUpdateCommand(buildUpdate(), buildContext({ isRetained: true })),
    ).toMatchObject({
      answer: 'alarm',
      alarm: AlarmCode.RetainedCommandDropped,
    });
  });

  it('refuses a foreign issuer and alarms a controller conflict', () => {
    expect(
      judgeUpdateCommand(buildUpdate({ issuedBy: 'laptop' }), buildContext()),
    ).toMatchObject({ answer: 'alarm', alarm: AlarmCode.ControllerConflict });
  });

  it('only logs any update before a controller is bound, unlike gpio/set', () => {
    for (const issuedBy of [SERVER, 'laptop']) {
      expect(
        judgeUpdateCommand(
          buildUpdate({ issuedBy }),
          buildContext({ boundController: null }),
        ),
      ).toMatchObject({ isAccepted: false, answer: 'log' });
    }
  });

  it('refuses an expired update and alarms', () => {
    expect(
      judgeUpdateCommand(
        buildUpdate({ expiresAt: '2026-11-21T11:59:59Z' }),
        buildContext(),
      ),
    ).toMatchObject({ answer: 'alarm', alarm: AlarmCode.CommandExpired });
  });

  it('judges the retain flag before ownership, and ownership before expiry', () => {
    const foreignAndExpired = buildUpdate({
      issuedBy: 'laptop',
      expiresAt: '2026-11-21T11:00:00Z',
    });

    expect(
      judgeUpdateCommand(foreignAndExpired, buildContext({ isRetained: true })),
    ).toMatchObject({ alarm: AlarmCode.RetainedCommandDropped });
    expect(judgeUpdateCommand(foreignAndExpired, buildContext())).toMatchObject(
      { alarm: AlarmCode.ControllerConflict },
    );
  });

  it.each([
    ['not JSON', '{not json'],
    ['a JSON array', '[]'],
    ['another schema major', buildUpdate({ schema: 'update/2' })],
    ['no expiresAt', buildUpdate({ expiresAt: undefined })],
    ['an unparseable expiresAt', buildUpdate({ expiresAt: 'soon' })],
    ['a bare year as expiresAt', buildUpdate({ expiresAt: '2027' })],
    ['a date with no time', buildUpdate({ expiresAt: '2027-01-01' })],
    ['an English date', buildUpdate({ expiresAt: 'Nov 21 2027' })],
    [
      'an instant with no offset',
      buildUpdate({ expiresAt: '2027-01-01T00:00:00' }),
    ],
    ['no id', buildUpdate({ id: '' })],
  ])('only logs an update with %s', (_description, payload) => {
    expect(judgeUpdateCommand(payload, buildContext())).toMatchObject({
      isAccepted: false,
      answer: 'log',
    });
  });

  it.each([
    [
      'another app',
      { app: AgentApp.MicroPython },
      'this node runs agent-linux',
    ],
    ['an unknown app', { app: 'agent-zephyr' }, 'unknown app'],
    ['another contract major', { version: '2.0.0' }, 'contract major 2'],
    ['an unparseable version', { version: 'latest' }, 'unparseable version'],
    [
      'a manifest that is not http',
      { manifestUrl: 'file:///etc/passwd' },
      'not an http(s) URL',
    ],
    [
      'a malformed manifest URL',
      { manifestUrl: 'elantris' },
      'not an http(s) URL',
    ],
    [
      'an uppercase sha256',
      { manifestSha256: 'A'.repeat(64) },
      '64 lowercase hex',
    ],
    ['a short sha256', { manifestSha256: 'abc' }, '64 lowercase hex'],
  ])(
    'reports %s back to the server as a failed update',
    (_description, overrides, reasonFragment) => {
      const verdict = judgeUpdateCommand(
        buildUpdate(overrides),
        buildContext(),
      );

      expect(verdict).toMatchObject({
        isAccepted: false,
        answer: 'failed-status',
        commandId: 'update-1',
      });
      expect(!verdict.isAccepted && verdict.reason).toContain(reasonFragment);
    },
  );

  it.each([
    '2026-11-21T12:05:00Z',
    '2026-11-21T12:05:00.250Z',
    '2026-11-21T07:05:00-05:00',
  ])('accepts an ISO-8601 expiresAt of %s', (expiresAt) => {
    expect(
      judgeUpdateCommand(buildUpdate({ expiresAt }), buildContext()).isAccepted,
    ).toBe(true);
  });

  it('accepts a development build of the same contract major', () => {
    const verdict = judgeUpdateCommand(
      buildUpdate({ version: '1.1.4-dev+ecdbbe7.dirty' }),
      buildContext(),
    );

    expect(verdict.isAccepted).toBe(true);
  });
});

describe('isUpdateStatusPayload', () => {
  const status = {
    schema: MQTT_SCHEMAS.updateStatus,
    node: 'patji',
    ts: NOW.toISOString(),
    id: 'update-1',
    state: UpdateState.RolledBack,
    reason: 'health check failed',
  };

  it('accepts a status with a known state', () => {
    expect(isUpdateStatusPayload(status)).toBe(true);
    expect(isUpdateStatusPayload({ ...status, reason: undefined })).toBe(true);
  });

  it.each([
    ['not an object', 'healthy'],
    ['another schema major', { ...status, schema: 'updateStatus/2' }],
    ['no command id', { ...status, id: '' }],
    ['an unknown state', { ...status, state: 'done' }],
    ['a reason that is not text', { ...status, reason: 42 }],
  ])('refuses a status with %s', (_description, value) => {
    expect(isUpdateStatusPayload(value)).toBe(false);
  });
});

describe('readVersionMajor', () => {
  it('reads the contract major from a released or development version', () => {
    expect(readVersionMajor('1.1.4')).toBe(1);
    expect(readVersionMajor('2.0.0-dev+ecdbbe7')).toBe(2);
    expect(readVersionMajor('v1')).toBeNull();
  });
});
