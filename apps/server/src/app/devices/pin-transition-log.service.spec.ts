import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HardwareService,
  NodeAvailability,
  PinStateReport,
} from '../hardware/hardware.service';
import { FixedClock } from '../common/clock';
import { PinTransitionLog } from './pin-transition-log.service';

const AT = new Date('2026-09-10T18:03:00Z');

function report(overrides: Partial<PinStateReport> = {}): PinStateReport {
  return {
    nodeId: 'elantris',
    pin: 5,
    level: 0,
    known: true,
    observedAt: AT,
    live: true,
    ...overrides,
  };
}

function wentOffline(at: Date): NodeAvailability {
  return { nodeId: 'elantris', online: false, at };
}

interface StoredRows {
  existing?: unknown;
  device?: unknown;
  latestPerPin?: unknown[];
}

function buildHarness(stored: StoredRows = {}) {
  const inserted: Record<string, unknown>[] = [];
  const pinStates = new Subject<PinStateReport>();
  const availability = new Subject<NodeAvailability>();

  const latestPerPinQuery = {
    distinctOn: () => latestPerPinQuery,
    where: () => latestPerPinQuery,
    orderBy: () => latestPerPinQuery,
    addOrderBy: () => latestPerPinQuery,
    getMany: async () => stored.latestPerPin ?? [],
  };
  const transitions = {
    insert: vi.fn(async (row: Record<string, unknown>) => {
      inserted.push(row);
    }),
    findOne: vi.fn(async () => stored.existing ?? null),
    createQueryBuilder: () => latestPerPinQuery,
  };
  const devices = { findOne: vi.fn(async () => stored.device ?? null) };
  const hardware = {
    pinStates$: pinStates.asObservable(),
    availability$: availability.asObservable(),
  } as unknown as HardwareService;

  const log = new PinTransitionLog(
    transitions as never,
    devices as never,
    hardware,
    new FixedClock(AT),
  );
  return { log, inserted, pinStates, availability, transitions, devices };
}

describe('PinTransitionLog', () => {
  let harness: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('records the first sight of a pin', async () => {
    await harness.log.record(report());
    expect(harness.inserted).toHaveLength(1);
    expect(harness.inserted[0]).toMatchObject({
      nodeId: 'elantris',
      pin: 5,
      level: 0,
      known: true,
      reason: 'first-sight',
      observedAt: AT,
    });
  });

  it('records a change and then stays silent while the level holds', async () => {
    await harness.log.record(report({ level: 1 }));
    await harness.log.record(
      report({ level: 0, observedAt: new Date(AT.getTime() + 1000) }),
    );
    await harness.log.record(
      report({ level: 0, observedAt: new Date(AT.getTime() + 2000) }),
    );
    await harness.log.record(
      report({ level: 0, observedAt: new Date(AT.getTime() + 3000) }),
    );

    expect(harness.inserted.map((row) => row['reason'])).toEqual([
      'first-sight',
      'level-changed',
    ]);
  });

  it('does not invent a transition from retained state after a restart', async () => {
    // Every node republishes retained gpio/state on connect; the table must be read first.
    const restarted = buildHarness({
      existing: { level: 0, known: true, observedAt: AT },
    });
    await restarted.log.record(
      report({ level: 0, observedAt: new Date(AT.getTime() + 5000) }),
    );

    expect(restarted.transitions.findOne).toHaveBeenCalled();
    expect(restarted.inserted).toEqual([]);
  });

  it('freezes what the level MEANT, using the device polarity at the time', async () => {
    // BCM 26 is active-HIGH on a board whose other four channels are active-LOW.
    const metalHalide = buildHarness({
      device: { id: 'dev-mh', name: 'MH Light', onLevel: 1, role: 'lights' },
    });
    await metalHalide.log.record(report({ pin: 26, level: 1 }));
    expect(metalHalide.inserted[0]).toMatchObject({
      energised: true,
      deviceId: 'dev-mh',
      role: 'lights',
    });

    const highPressureSodium = buildHarness({
      device: { id: 'dev-hps', name: 'HPS', onLevel: 0, role: 'lights' },
    });
    await highPressureSodium.log.record(report({ pin: 21, level: 1 }));
    expect(highPressureSodium.inserted[0]).toMatchObject({ energised: false });
  });

  it('records losing track of a line, with energised null rather than false', async () => {
    const co2Generator = buildHarness({
      device: { id: 'd', name: 'CO2', onLevel: 0, role: 'co2_generator' },
    });
    await co2Generator.log.record(report({ level: 0 }));
    await co2Generator.log.record(
      report({
        level: null,
        known: false,
        observedAt: new Date(AT.getTime() + 1000),
      }),
    );
    expect(co2Generator.inserted[1]).toMatchObject({
      reason: 'became-unknown',
      energised: null,
    });
  });

  it('logs a pin no device claims, because the copper still moved', async () => {
    // BCM 12 drives nothing and BCM 16 is going dark. Both still report.
    await harness.log.record(report({ pin: 12 }));
    expect(harness.inserted[0]).toMatchObject({
      pin: 12,
      deviceId: null,
      role: null,
    });
  });

  it('survives a write failure without killing the subscription', async () => {
    const failing = buildHarness();
    failing.transitions.insert.mockRejectedValueOnce(new Error('db gone'));
    failing.log.onModuleInit();

    failing.pinStates.next(report({ level: 1 }));
    await settle();
    failing.pinStates.next(
      report({ level: 0, observedAt: new Date(AT.getTime() + 1000) }),
    );
    await settle();

    // The second report still got through, which is the whole assertion.
    expect(failing.transitions.insert).toHaveBeenCalledTimes(2);
    failing.log.onModuleDestroy();
  });

  describe('a node going offline', () => {
    const DROPPED_AT = new Date(AT.getTime() + 60_000);
    const knownRow = (pin: number, observedAt = AT) => ({
      nodeId: 'elantris',
      pin,
      level: 0,
      known: true,
      observedAt,
    });

    it('writes an unknown row for each known pin, stamped when it dropped', async () => {
      const offline = buildHarness({
        latestPerPin: [knownRow(5), knownRow(17)],
        device: { id: 'd', name: 'CO2', onLevel: 0, role: 'co2_generator' },
      });
      offline.log.onModuleInit();

      offline.availability.next(wentOffline(DROPPED_AT));
      await settle();

      expect(offline.inserted).toHaveLength(2);
      expect(offline.inserted[0]).toMatchObject({
        pin: 5,
        level: null,
        known: false,
        energised: null,
        deviceId: 'd',
        reason: 'node-offline',
        observedAt: DROPPED_AT,
      });
      offline.log.onModuleDestroy();
    });

    it('writes nothing for a pin already unknown', async () => {
      const offline = buildHarness({
        latestPerPin: [{ ...knownRow(5), level: null, known: false }],
      });
      await offline.log.recordNodeOffline(wentOffline(DROPPED_AT));
      expect(offline.inserted).toEqual([]);
    });

    it('ignores a node coming online', async () => {
      const online = buildHarness({ latestPerPin: [knownRow(5)] });
      online.log.onModuleInit();
      online.availability.next({ ...wentOffline(DROPPED_AT), online: true });
      await settle();
      expect(online.inserted).toEqual([]);
      online.log.onModuleDestroy();
    });

    it('keeps the row after the last one when the node clock ran ahead', async () => {
      const aheadAt = new Date(DROPPED_AT.getTime() + 5000);
      const offline = buildHarness({ latestPerPin: [knownRow(5, aheadAt)] });
      await offline.log.recordNodeOffline(wentOffline(DROPPED_AT));
      expect(offline.inserted[0]).toMatchObject({ observedAt: aheadAt });
    });

    it('records the pin again once the node reports it on reconnect', async () => {
      const offline = buildHarness({ latestPerPin: [knownRow(5)] });
      await offline.log.recordNodeOffline(wentOffline(DROPPED_AT));
      await offline.log.record(
        report({ level: 0, observedAt: new Date(DROPPED_AT.getTime() + 1000) }),
      );
      expect(offline.inserted.map((row) => row['reason'])).toEqual([
        'node-offline',
        'level-changed',
      ]);
    });
  });
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
