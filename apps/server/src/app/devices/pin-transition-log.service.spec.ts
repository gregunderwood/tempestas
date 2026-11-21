import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HardwareService,
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

function buildHarness(stored: { existing?: unknown; device?: unknown } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const pinStates = new Subject<PinStateReport>();

  const transitions = {
    insert: vi.fn(async (row: Record<string, unknown>) => {
      inserted.push(row);
    }),
    findOne: vi.fn(async () => stored.existing ?? null),
  };
  const devices = { findOne: vi.fn(async () => stored.device ?? null) };
  const hardware = {
    pinStates$: pinStates.asObservable(),
  } as unknown as HardwareService;

  const log = new PinTransitionLog(
    transitions as never,
    devices as never,
    hardware,
    new FixedClock(AT),
  );
  return { log, inserted, pinStates, transitions, devices };
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
});

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
