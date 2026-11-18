import type { DataSource, Repository } from 'typeorm';
import { DeviceRole, type RulesEvaluation } from '@tempestas/domain';
import { FixedClock } from '../common/clock';
import type { NodesService } from '../nodes/nodes.service';
import type { SensorReadingEntity } from '../readings/models';
import type { RulesService } from '../rules/rules.service';
import { HealthService } from './health.service';
import { DivergenceLog } from '../common/divergence-log';

const NOW = new Date('2026-01-10T12:00:00Z');

function evaluation(overrides: Partial<RulesEvaluation> = {}): RulesEvaluation {
  return {
    zoneId: 'zone-1',
    zoneSlug: 'greenhouse',
    evaluatedAt: NOW.toISOString(),
    minutesSinceMidnightLocal: 240,
    localTime: '04:00',
    timezone: 'America/Vancouver',
    enabledRoles: [DeviceRole.Co2Generator],
    climateByRole: {},
    staleRoles: [],
    decisions: [],
    ...overrides,
  };
}

interface Setup {
  dbUp?: boolean;
  latestReading?: Date | null;
  counts?: { total: number; online: number; pending: number };
  evaluations?: RulesEvaluation[];
  failingZones?: Map<string, string>;
  divergences?: DivergenceLog;
}

function makeService(setup: Setup = {}) {
  const dataSource = {
    query: vi.fn(async () => {
      if (setup.dbUp === false) throw new Error('ECONNREFUSED');
      return [{ '1': 1 }];
    }),
  } as unknown as DataSource;

  const builder = {
    select: () => builder,
    addSelect: () => builder,
    getRawOne: async () => ({
      latest: setup.latestReading === undefined ? NOW : setup.latestReading,
    }),
  };
  const readings = {
    createQueryBuilder: () => builder,
  } as unknown as Repository<SensorReadingEntity>;

  const nodes = {
    counts: vi
      .fn()
      .mockResolvedValue(setup.counts ?? { total: 2, online: 2, pending: 0 }),
  } as unknown as NodesService;
  const rules = {
    lastEvaluation: vi.fn(() => setup.evaluations ?? [evaluation()]),
    failingZones: vi.fn(() => setup.failingZones ?? new Map()),
  } as unknown as RulesService;

  return new HealthService(
    dataSource,
    readings,
    nodes,
    rules,
    new FixedClock(NOW),
    setup.divergences ?? new DivergenceLog(),
  );
}

describe('HealthService', () => {
  it('is ok when the database, the readings and the engine are all current', async () => {
    const report = await makeService().check();
    expect(report).toMatchObject({
      status: 'ok',
      db: true,
      nodes: { total: 2, online: 2, pending: 0 },
      problems: [],
    });
    expect(report.readings.ageSeconds).toBe(0);
    expect(report.rules.ageSeconds).toBe(0);
  });

  // "Up" is not the question. A process answering HTTP while nothing has
  // arrived in two minutes is a greenhouse running open-loop.
  it('is degraded when readings have stopped arriving', async () => {
    const report = await makeService({
      latestReading: new Date('2026-01-10T11:50:00Z'),
    }).check();
    expect(report.status).toBe('degraded');
    expect(report.problems).toContainEqual(expect.stringContaining('600s old'));
  });

  it('is degraded when the rules engine has stopped evaluating', async () => {
    const stale = evaluation({ evaluatedAt: '2026-01-10T11:55:00Z' });
    const report = await makeService({ evaluations: [stale] }).check();
    expect(report.status).toBe('degraded');
    expect(report.problems).toContainEqual(expect.stringContaining('300s ago'));
  });

  it('is degraded before the engine has ever run', async () => {
    const report = await makeService({ evaluations: [] }).check();
    expect(report.status).toBe('degraded');
    expect(report.problems).toContainEqual(
      'the rules engine has not evaluated yet',
    );
  });

  it('is degraded when no reading has ever been persisted', async () => {
    const report = await makeService({ latestReading: null }).check();
    expect(report.status).toBe('degraded');
    expect(report.readings).toEqual({ latestAt: null, ageSeconds: null });
  });

  // A zone that fails evaluation drives nothing - for the pumphouse, a heater
  // nobody is controlling. The reason goes in the message, not just the log.
  it('names a zone that is not being evaluated, and why', async () => {
    const report = await makeService({
      failingZones: new Map([
        [
          'pumphouse',
          'invalid rules_config: rules.heater.onAtC must be a number',
        ],
      ]),
    }).check();
    expect(report.status).toBe('degraded');
    expect(report.problems).toContain(
      'zone "pumphouse" is not being evaluated: invalid rules_config: rules.heater.onAtC must be a number',
    );
  });

  it('surfaces stale sensors, which is the banner condition', async () => {
    const report = await makeService({
      evaluations: [evaluation({ staleRoles: [DeviceRole.Co2Generator] })],
    }).check();
    expect(report.status).toBe('degraded');
    expect(report.rules.staleRoles).toEqual([DeviceRole.Co2Generator]);
  });

  // A pending node is the admission gate working, not a fault - but it is the
  // thing somebody curling this endpoint most often needs told.
  it('reports a pending node without calling the system degraded', async () => {
    const report = await makeService({
      counts: { total: 3, online: 3, pending: 1 },
    }).check();
    expect(report.status).toBe('ok');
    expect(report.problems).toContainEqual('1 node(s) awaiting admission');
  });

  // The caller is trying to find out what broke; a 500 tells them nothing.
  it('reports what is knowable when the database is unreachable', async () => {
    const report = await makeService({ dbUp: false }).check();
    expect(report).toMatchObject({
      status: 'degraded',
      db: false,
      problems: ['database unreachable'],
    });
    expect(report.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

// A relay and its row having disagreed means something upstream already failed.
// Correcting the row is the fix; keeping it on a surface somebody reads is the
// alarm, and this endpoint is what anything that is not a browser polls.
describe('HealthService divergence reporting', () => {
  function loggedAt(at: Date): DivergenceLog {
    const log = new DivergenceLog();
    log.record({
      deviceName: 'CO2 Generator',
      nodeId: 'elantris',
      pin: 5,
      hardwareOn: false,
      reason: 'hardware reports de-energised, the row said on',
      at,
    });
    return log;
  }

  it('reports a recent divergence and calls the system degraded', async () => {
    const health = await makeService({
      divergences: loggedAt(new Date(NOW.getTime() - 60_000)),
    }).check();
    expect(health.problems).toContainEqual(
      expect.stringContaining('CO2 Generator'),
    );
    expect(health.status).toBe('degraded');
  });

  // An overnight failsafe has to still be reported when somebody looks in the
  // morning, so the window is a day rather than minutes.
  it('still reports one from eight hours ago', async () => {
    const health = await makeService({
      divergences: loggedAt(new Date(NOW.getTime() - 8 * 3600_000)),
    }).check();
    expect(health.problems).toContainEqual(
      expect.stringContaining('divergence'),
    );
  });

  it('lets one age out rather than reporting it forever', async () => {
    const health = await makeService({
      divergences: loggedAt(new Date(NOW.getTime() - 25 * 3600_000)),
    }).check();
    expect(health.problems).not.toContainEqual(
      expect.stringContaining('divergence'),
    );
  });
});
