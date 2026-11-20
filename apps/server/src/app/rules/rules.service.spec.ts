import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  ApiErrorCode,
  DeviceRole,
  type RulesCycle,
  type RulesEvaluation,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { DevicesService } from '../devices/devices.service';
import type { DeviceEntity } from '../devices/models';
import type { SensorReadingEntity } from '../readings/models';
import type { NodesService } from '../nodes/nodes.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { ZoneEntity } from '../zones/models';
import { RulesService } from './rules.service';

/** 20:04Z is 12:04 PST - inside the 06:30-18:30 day window. */
const NOW = new Date('2026-01-10T20:04:00Z');
const OBSERVED = new Date('2026-01-10T20:03:30Z');

function rulesConfig(
  overrides: Partial<ZoneRulesConfig> = {},
): ZoneRulesConfig {
  return {
    enabledRoles: [DeviceRole.Co2Generator],
    sensorPolicy: { default: { source: 'mean', maxAgeMs: 120_000 } },
    daylight: { start: '06:30', end: '18:30' },
    rules: {
      [DeviceRole.Lights]: {
        kind: 'daylight-thermostat',
        mode: 'heat',
        onAtC: 26,
        offAtC: 27,
        onStale: 'hold',
      },
      [DeviceRole.Co2Generator]: {
        kind: 'co2-burner',
        dayOffAtC: 26,
        nightOnBelowC: 3,
        co2OnPpm: 1400,
        co2OffPpm: 1500,
        onStale: 'hold',
      },
      [DeviceRole.ExhaustFan]: {
        kind: 'thermostat',
        mode: 'cool',
        onAtC: 30,
        offAtC: 29.5,
        onStale: 'hold',
      },
    },
    timezone: 'America/Vancouver',
    ...overrides,
  };
}

function zone(overrides: Partial<ZoneEntity> = {}): ZoneEntity {
  return {
    id: 'zone-1',
    slug: 'greenhouse',
    displayName: 'Greenhouse',
    rulesConfig: rulesConfig(),
    ...overrides,
  } as ZoneEntity;
}

function device(overrides: Partial<DeviceEntity> = {}): DeviceEntity {
  return {
    id: 'dev-burner',
    name: 'CO2 Generator',
    zoneId: 'zone-1',
    gpio: 16,
    onDelayDuration: 300,
    onAt: null,
    offAt: null,
    onLevel: 0,
    rulesEnabled: true,
    role: DeviceRole.Co2Generator,
    ...overrides,
  } as DeviceEntity;
}

interface Setup {
  zones?: ZoneEntity[];
  samples?: {
    slug: string;
    temperature: number;
    co2: number | null;
    observedAt: Date;
  }[];
  devicesByRole?: Partial<Record<DeviceRole, DeviceEntity[]>>;
  turnOn?: ReturnType<typeof vi.fn>;
  turnOff?: ReturnType<typeof vi.fn>;
  now?: Date;
  isLeader?: boolean;
}

function makeService(setup: Setup = {}) {
  const zoneRows = setup.zones ?? [zone()];
  const samples = setup.samples ?? [
    { slug: 'elantris', temperature: 20, co2: 800, observedAt: OBSERVED },
  ];

  const zones = {
    find: vi.fn(async () => zoneRows),
  } as unknown as Repository<ZoneEntity>;

  // The DISTINCT ON query builder chain. Every method returns the builder;
  // getRawMany resolves the rows the real query would produce.
  const builder: Record<string, unknown> = {};
  for (const method of [
    'innerJoin',
    'select',
    'addSelect',
    'distinctOn',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
  ]) {
    builder[method] = () => builder;
  }
  builder['getRawMany'] = async () => samples;
  const readings = {
    createQueryBuilder: () => builder,
  } as unknown as Repository<SensorReadingEntity>;

  const turnOn = setup.turnOn ?? vi.fn().mockResolvedValue(undefined);
  const turnOff = setup.turnOff ?? vi.fn().mockResolvedValue(undefined);
  const findByRole = vi.fn(async (_zoneId: string, role: DeviceRole) => {
    return setup.devicesByRole?.[role] ?? [];
  });
  const devices = { findByRole, turnOn, turnOff } as unknown as DevicesService;

  const nodes = {
    counts: vi.fn().mockResolvedValue({ total: 2, online: 2, pending: 0 }),
  } as unknown as NodesService;
  const publishSystemStatus = vi.fn();
  const publishRulesCycle = vi.fn();
  const forgetRulesCycle = vi.fn();
  const realtime = {
    publishSystemStatus,
    publishRulesCycle,
    forgetRulesCycle,
  } as unknown as RealtimeGateway;
  const hardware = { isLeader: setup.isLeader ?? true } as {
    isLeader: boolean;
  };

  const service = new RulesService(
    zones,
    readings,
    devices,
    nodes,
    realtime,
    new FixedClock(setup.now ?? NOW),
    // These cases are all about what a LEADER decides. Follower behaviour has
    // its own test below, where the assertion is that nothing is evaluated.
    hardware as HardwareService,
  );
  return {
    service,
    turnOn,
    turnOff,
    findByRole,
    publishSystemStatus,
    publishRulesCycle,
    forgetRulesCycle,
    hardware,
    zoneRows,
  };
}

describe('Checkpoint 5', () => {
  // THE checkpoint: with enabledRoles ['co2_generator'] and a lights device
  // present, a cool greenhouse drives ONLY the burner. Ownership is explicit,
  // so the lights row existing is not permission to drive it - which is what
  // makes it safe to re-enter every device before the cutover.
  it('drives only the burner when the zone owns only the burner', async () => {
    const { service, turnOn } = makeService({
      devicesByRole: {
        [DeviceRole.Co2Generator]: [device()],
        [DeviceRole.Lights]: [
          device({
            id: 'dev-lights',
            name: 'Lights',
            gpio: 21,
            role: DeviceRole.Lights,
          }),
        ],
      },
    });

    const [evaluation] = await service.evaluateAll();

    expect(turnOn).toHaveBeenCalledTimes(1);
    expect(turnOn).toHaveBeenCalledWith('dev-burner');

    const byRole = Object.fromEntries(
      evaluation.decisions.map((d) => [d.role, d]),
    );
    expect(byRole[DeviceRole.Co2Generator]).toMatchObject({
      desired: 'on',
      reason: 'co2-below-threshold',
      dispatched: [{ deviceId: 'dev-burner', outcome: 'applied' }],
    });
    expect(byRole[DeviceRole.Lights]).toMatchObject({
      desired: 'noop',
      reason: 'role-not-owned',
      dispatched: [],
    });
  });

  it('does not even look up devices for a role it does not own', async () => {
    const { service, findByRole } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.evaluateAll();
    expect(findByRole).toHaveBeenCalledTimes(1);
    expect(findByRole).toHaveBeenCalledWith('zone-1', DeviceRole.Co2Generator);
  });
});

describe('dispatch outcomes', () => {
  it('records a manual override without touching the hardware', async () => {
    const { service, turnOn } = makeService({
      devicesByRole: {
        [DeviceRole.Co2Generator]: [device({ rulesEnabled: false })],
      },
    });
    const [evaluation] = await service.evaluateAll();

    expect(turnOn).not.toHaveBeenCalled();
    expect(evaluation.decisions[1].dispatched).toEqual([
      {
        deviceId: 'dev-burner',
        deviceName: 'CO2 Generator',
        outcome: 'rules-disabled',
      },
    ]);
  });

  // The interlock lives in DevicesService and this is an in-process caller, so
  // the refusal a rule gets is the same one a human gets from the API.
  it('swallows the anti-short-cycle refusal and reports when it may retry', async () => {
    const turnOn = vi.fn().mockRejectedValue(
      new ConflictException({
        code: ApiErrorCode.DeviceCooldown,
        message: 'within its minimum-off time',
        details: { canTurnOnAt: '2026-01-10T20:09:00.000Z' },
      }),
    );
    const { service } = makeService({
      turnOn,
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();

    expect(evaluation.decisions[1].dispatched).toEqual([
      {
        deviceId: 'dev-burner',
        deviceName: 'CO2 Generator',
        outcome: 'cooldown',
        detail: '2026-01-10T20:09:00.000Z',
      },
    ]);
  });

  it('treats already-on as a no-change, not a failure', async () => {
    const turnOn = vi.fn().mockRejectedValue(
      new ConflictException({
        code: ApiErrorCode.DeviceAlreadyOn,
        message: 'already on',
      }),
    );
    const { service } = makeService({
      turnOn,
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();
    expect(evaluation.decisions[1].dispatched[0].outcome).toBe(
      'already-in-state',
    );
  });

  it('reports a refused node as a failure, with the code', async () => {
    const turnOn = vi.fn().mockRejectedValue(
      new ConflictException({
        code: ApiErrorCode.NodeNotAdmitted,
        message: 'not admitted',
      }),
    );
    const { service } = makeService({
      turnOn,
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();
    expect(evaluation.decisions[1].dispatched[0]).toMatchObject({
      outcome: 'failed',
      detail: ApiErrorCode.NodeNotAdmitted,
    });
  });

  it('reports a non-HTTP failure without pretending to know a code', async () => {
    const turnOn = vi.fn().mockRejectedValue(new Error('READBACK_MISMATCH'));
    const { service } = makeService({
      turnOn,
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();
    expect(evaluation.decisions[1].dispatched[0]).toMatchObject({
      outcome: 'failed',
      detail: 'READBACK_MISMATCH',
    });
  });

  // Every device sharing a (zone, role) gets the same decision, and one
  // failure must not stop the rest.
  it('drives every device sharing a role, independently', async () => {
    const turnOff = vi
      .fn()
      .mockRejectedValueOnce(new Error('first one failed'))
      .mockResolvedValueOnce(undefined);
    const { service } = makeService({
      zones: [
        zone({
          rulesConfig: rulesConfig({ enabledRoles: [DeviceRole.ExhaustFan] }),
        }),
      ],
      samples: [
        { slug: 'elantris', temperature: 20, co2: 800, observedAt: OBSERVED },
      ],
      turnOff,
      devicesByRole: {
        [DeviceRole.ExhaustFan]: [
          device({ id: 'fan-1', name: 'Fan 1', role: DeviceRole.ExhaustFan }),
          device({ id: 'fan-2', name: 'Fan 2', role: DeviceRole.ExhaustFan }),
        ],
      },
    });

    const [evaluation] = await service.evaluateAll();
    const fan = evaluation.decisions.find(
      (d) => d.role === DeviceRole.ExhaustFan,
    );

    expect(fan).toMatchObject({
      desired: 'off',
      reason: 'temp-below-setpoint',
    });
    expect(fan?.dispatched.map((d) => d.outcome)).toEqual([
      'failed',
      'applied',
    ]);
  });
});

describe('the evaluation record', () => {
  it('echoes back every input that produced the decisions', async () => {
    const { service } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();

    expect(evaluation).toMatchObject({
      zoneId: 'zone-1',
      zoneSlug: 'greenhouse',
      evaluatedAt: NOW.toISOString(),
      minutesSinceMidnightLocal: 12 * 60 + 4,
      localTime: '12:04',
      timezone: 'America/Vancouver',
      enabledRoles: [DeviceRole.Co2Generator],
      staleRoles: [],
    });
    expect(evaluation.climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      temperatureC: 20,
      co2Ppm: 800,
      sourceNodeIds: ['elantris'],
    });
  });

  it('is empty before the first evaluation, then retrievable', async () => {
    const { service } = makeService();
    expect(service.lastEvaluation()).toEqual([]);
    await service.evaluateAll();
    expect(service.lastEvaluation()).toHaveLength(1);
  });
});

describe('degraded conditions', () => {
  // Stale sensors hold last state: neither failing everything off (which can
  // freeze the greenhouse) nor forcing heat on (which can cook it) is safe.
  it('holds last state and dispatches nothing when the sensors are stale', async () => {
    const { service, turnOn, turnOff } = makeService({
      samples: [
        {
          slug: 'elantris',
          temperature: 20,
          co2: 800,
          observedAt: new Date('2026-01-10T19:00:00Z'),
        },
      ],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();

    expect(evaluation.staleRoles).toEqual([
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ]);
    expect(evaluation.decisions[1]).toMatchObject({
      desired: 'noop',
      reason: 'sensor-stale',
    });
    expect(turnOn).not.toHaveBeenCalled();
    expect(turnOff).not.toHaveBeenCalled();
  });

  it('no-ops when no node has reported at all', async () => {
    const { service, turnOn } = makeService({
      samples: [],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const [evaluation] = await service.evaluateAll();
    expect(evaluation.decisions[1]).toMatchObject({
      desired: 'noop',
      reason: 'no-sensor',
    });
    expect(turnOn).not.toHaveBeenCalled();
  });

  // A hand-edited rules_config on one zone must not stop the zone that runs
  // the burner from being evaluated.
  it('keeps evaluating other zones when one zone is misconfigured', async () => {
    const broken = zone({
      id: 'zone-broken',
      slug: 'broken',
      rulesConfig: rulesConfig({ timezone: 'Mars/Olympus_Mons' }),
    });
    const { service } = makeService({
      zones: [broken, zone()],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });

    const evaluations = await service.evaluateAll();
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].zoneSlug).toBe('greenhouse');
  });

  // A typo in hand-edited jsonb used to read as `undefined`, which every
  // comparison treats as false: the role sat in its dead band forever and
  // reported a calm-looking "dead-band". Now the zone is refused, whole.
  it('refuses a zone whose rules_config does not parse, and drives nothing', async () => {
    const typo = rulesConfig();
    (typo.rules[DeviceRole.Co2Generator] as unknown as Record<string, unknown>)[
      'co2OnPmm'
    ] = 1400;
    const { service, turnOn, turnOff } = makeService({
      zones: [zone({ rulesConfig: typo })],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });

    expect(await service.evaluateAll()).toEqual([]);
    expect(turnOn).not.toHaveBeenCalled();
    expect(turnOff).not.toHaveBeenCalled();
    expect(service.failingZones().get('greenhouse')).toMatch(
      /co2OnPmm is not a recognised setting/,
    );
  });

  it('forgets a failure once the zone evaluates again', async () => {
    const broken = zone({ rulesConfig: rulesConfig({ timezone: 'X/Y' }) });
    const { service } = makeService({
      zones: [broken],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.evaluateAll();
    expect(service.failingZones().has('greenhouse')).toBe(true);

    broken.rulesConfig = rulesConfig();
    await service.evaluateAll();
    expect(service.failingZones().size).toBe(0);
  });

  // Bootstrap reads enabledRoles to log ownership. A broken zone there used to
  // be an exception in onApplicationBootstrap - a server that will not start.
  it('starts despite a zone with a broken config', async () => {
    const { service } = makeService({
      zones: [zone({ rulesConfig: {} as ZoneRulesConfig })],
    });
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('skips a tick while the previous evaluation is still running', async () => {
    const { service } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const spy = vi.spyOn(service, 'evaluateAll');

    await Promise.all([service.tick(), service.tick()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('logs ownership on bootstrap without evaluating anything', async () => {
    const { service, turnOn } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.onApplicationBootstrap();
    expect(turnOn).not.toHaveBeenCalled();
  });
});

// Layer 1 of the safety design holds last state when readings stop, and says so
// out loud: "this is only sound if the alarm is actually visible." The banner is
// driven by this event, so it is a required part of the feature.
describe('system status fan-out', () => {
  it('publishes a healthy status once per cycle, not once per zone', async () => {
    const { service, publishSystemStatus } = makeService({
      zones: [zone(), zone({ id: 'zone-2', slug: 'shed' })],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.evaluateAll();

    expect(publishSystemStatus).toHaveBeenCalledTimes(1);
    expect(publishSystemStatus).toHaveBeenCalledWith({
      at: NOW.toISOString(),
      sensorStale: false,
      staleRoles: [],
      nodesOnline: 2,
      nodesTotal: 2,
      lastEvaluationAt: NOW.toISOString(),
    });
  });

  it('raises sensorStale so the dashboard can raise its banner', async () => {
    const { service, publishSystemStatus } = makeService({
      samples: [
        {
          slug: 'elantris',
          temperature: 20,
          co2: 800,
          observedAt: new Date('2026-01-10T19:00:00Z'),
        },
      ],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.evaluateAll();

    expect(publishSystemStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        sensorStale: true,
        staleRoles: [
          DeviceRole.Lights,
          DeviceRole.Co2Generator,
          DeviceRole.ExhaustFan,
        ],
      }),
    );
  });

  // A zone that throws must not take the status with it - that would remove the
  // banner at exactly the moment something is wrong.
  it('still publishes a status when a zone fails to evaluate', async () => {
    const { service, publishSystemStatus } = makeService({
      zones: [
        zone({
          id: 'z-bad',
          slug: 'broken',
          rulesConfig: rulesConfig({ timezone: 'X/Y' }),
        }),
      ],
    });
    await service.evaluateAll();
    expect(publishSystemStatus).toHaveBeenCalledWith(
      expect.objectContaining({ lastEvaluationAt: null }),
    );
  });
});

describe('a follower evaluates nothing', () => {
  it('does not dispatch, even where a leader plainly would', async () => {
    // Identical inputs. The ONLY difference between the two cases is the role,
    // which is what makes this evidence rather than a tautology.
    const leader = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await leader.service.tick();
    expect(leader.turnOn).toHaveBeenCalledWith('dev-burner');

    const follower = makeService({
      isLeader: false,
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await follower.service.tick();
    expect(follower.turnOn).not.toHaveBeenCalled();
    expect(follower.turnOff).not.toHaveBeenCalled();
  });
});

function cycleOf(evaluations: RulesEvaluation[]): RulesCycle {
  return { at: NOW.toISOString(), evaluations, failingZones: [] };
}

describe('publishing each rules cycle', () => {
  it('publishes every evaluation of the cycle in one message', async () => {
    const { service, publishRulesCycle } = makeService({
      zones: [zone(), zone({ id: 'zone-2', slug: 'shed' })],
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    const evaluations = await service.evaluateAll();

    expect(publishRulesCycle).toHaveBeenCalledTimes(1);
    expect(publishRulesCycle).toHaveBeenCalledWith(cycleOf(evaluations));
  });

  it('names a zone that could not be evaluated, with the reason', async () => {
    const { service, publishRulesCycle } = makeService({
      zones: [
        zone({ rulesConfig: rulesConfig({ timezone: 'Mars/Olympus_Mons' }) }),
      ],
    });
    await service.evaluateAll();

    const cycle = publishRulesCycle.mock.calls[0][0];
    expect(cycle.evaluations).toEqual([]);
    expect(cycle.failingZones).toEqual([
      { zoneSlug: 'greenhouse', reason: expect.stringMatching(/Mars/) },
    ]);
  });

  it('serves the newest cycle for first paint', async () => {
    const { service } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    expect(service.findLatestRulesCycle()).toBeNull();
    const evaluations = await service.evaluateAll();
    expect(service.findLatestRulesCycle()).toEqual(cycleOf(evaluations));
  });

  it('forgets the failure of a zone that has since been deleted', async () => {
    const broken = zone({
      id: 'zone-broken',
      slug: 'broken',
      rulesConfig: rulesConfig({ timezone: 'Mars/Olympus_Mons' }),
    });
    const { service, zoneRows } = makeService({ zones: [broken, zone()] });
    await service.evaluateAll();
    expect(
      service
        .findLatestRulesCycle()
        ?.failingZones.map((failure) => failure.zoneSlug),
    ).toEqual(['broken']);

    zoneRows.splice(0, 1);
    await service.evaluateAll();
    expect(service.findLatestRulesCycle()?.failingZones).toEqual([]);
    expect(service.failingZones().has('broken')).toBe(false);
  });

  it('forgets its last cycle once it is no longer the leader', async () => {
    const { service, hardware, forgetRulesCycle } = makeService({
      devicesByRole: { [DeviceRole.Co2Generator]: [device()] },
    });
    await service.tick();
    expect(service.findLatestRulesCycle()).not.toBeNull();

    hardware.isLeader = false;
    await service.tick();
    expect(service.findLatestRulesCycle()).toBeNull();
    expect(forgetRulesCycle).toHaveBeenCalledTimes(1);

    await service.tick();
    expect(forgetRulesCycle).toHaveBeenCalledTimes(1);
  });

  it('publishes no cycle when a follower is asked to evaluate', async () => {
    const { service, publishRulesCycle } = makeService({ isLeader: false });
    await service.evaluateAll();
    expect(publishRulesCycle).not.toHaveBeenCalled();
    expect(service.findLatestRulesCycle()).toBeNull();
  });
});
