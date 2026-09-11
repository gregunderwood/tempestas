import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HardwareService, PinStateReport } from '../hardware/hardware.service';
import { PinTransitionLog } from './pin-transition-log.service';

const AT = new Date('2026-09-10T18:03:00Z');

function report(over: Partial<PinStateReport> = {}): PinStateReport {
  return { nodeId: 'elantris', pin: 5, level: 0, known: true, observedAt: AT, ...over };
}

function build(opts: { existing?: unknown; device?: unknown } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const pinStates = new Subject<PinStateReport>();

  const transitions = {
    insert: vi.fn(async (row: Record<string, unknown>) => {
      inserted.push(row);
    }),
    findOne: vi.fn(async () => opts.existing ?? null),
  };
  const devices = { findOne: vi.fn(async () => opts.device ?? null) };
  const hardware = { pinStates$: pinStates.asObservable() } as unknown as HardwareService;

  const log = new PinTransitionLog(
    transitions as never,
    devices as never,
    hardware,
  );
  return { log, inserted, pinStates, transitions, devices };
}

describe('PinTransitionLog', () => {
  let harness: ReturnType<typeof build>;

  beforeEach(() => {
    harness = build();
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
    await harness.log.record(report({ level: 0, observedAt: new Date(AT.getTime() + 1000) }));
    await harness.log.record(report({ level: 0, observedAt: new Date(AT.getTime() + 2000) }));
    await harness.log.record(report({ level: 0, observedAt: new Date(AT.getTime() + 3000) }));

    expect(harness.inserted.map((r) => r['reason'])).toEqual([
      'first-sight',
      'level-changed',
    ]);
  });

  it('does not invent a transition from retained state after a restart', async () => {
    // THE regression this guards. Every node republishes retained gpio/state on
    // connect. A fresh process with an empty cache must read the table before
    // deciding, or every restart writes a transition where no relay moved -
    // and the log exists precisely to be trusted about when relays moved.
    const restarted = build({
      existing: { level: 0, known: true, observedAt: AT },
    });
    await restarted.log.record(report({ level: 0, observedAt: new Date(AT.getTime() + 5000) }));

    expect(restarted.transitions.findOne).toHaveBeenCalled();
    expect(restarted.inserted).toEqual([]);
  });

  it('freezes what the level MEANT, using the device polarity at the time', async () => {
    // BCM 26 is active-HIGH on a board whose other four channels are
    // active-LOW. Storing `energised` rather than deriving it later means
    // editing onLevel next month cannot rewrite last month's history.
    const mh = build({ device: { id: 'dev-mh', name: 'MH Light', onLevel: 1, role: 'lights' } });
    await mh.log.record(report({ pin: 26, level: 1 }));
    expect(mh.inserted[0]).toMatchObject({ energised: true, deviceId: 'dev-mh', role: 'lights' });

    const hps = build({ device: { id: 'dev-hps', name: 'HPS', onLevel: 0, role: 'lights' } });
    await hps.log.record(report({ pin: 21, level: 1 }));
    expect(hps.inserted[0]).toMatchObject({ energised: false });
  });

  it('records losing track of a line, with energised null rather than false', async () => {
    const h = build({ device: { id: 'd', name: 'CO2', onLevel: 0, role: 'co2_generator' } });
    await h.log.record(report({ level: 0 }));
    await h.log.record(
      report({ level: null, known: false, observedAt: new Date(AT.getTime() + 1000) }),
    );
    expect(h.inserted[1]).toMatchObject({ reason: 'became-unknown', energised: null });
  });

  it('logs a pin no device claims, because the copper still moved', async () => {
    // BCM 12 drives nothing and BCM 16 is going dark. Both still report.
    await harness.log.record(report({ pin: 12 }));
    expect(harness.inserted[0]).toMatchObject({ pin: 12, deviceId: null, role: null });
  });

  it('survives a write failure without killing the subscription', async () => {
    const h = build();
    h.transitions.insert.mockRejectedValueOnce(new Error('db gone'));
    h.log.onModuleInit();

    h.pinStates.next(report({ level: 1 }));
    await new Promise((r) => setTimeout(r, 0));
    h.pinStates.next(report({ level: 0, observedAt: new Date(AT.getTime() + 1000) }));
    await new Promise((r) => setTimeout(r, 0));

    // The second report still got through, which is the whole assertion.
    expect(h.transitions.insert).toHaveBeenCalledTimes(2);
    h.log.onModuleDestroy();
  });
});
