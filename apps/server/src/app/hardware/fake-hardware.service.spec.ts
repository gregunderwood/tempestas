import { firstValueFrom, toArray, take } from 'rxjs';
import { ApiErrorCode } from '@tempestas/domain';
import {
  DEFAULT_FAKE_NODES,
  FakeHardwareService,
} from './fake-hardware.service';
import type { SensorSample } from './hardware.service';

// elantris's own wiring: BCM 5 is the CO2 generator. Active-LOW, so 0 is on.
const BURNER = { pin: 5, level: 0 as const };
const FAN = { pin: 6, level: 0 as const };

describe('FakeHardwareService', () => {
  let hw: FakeHardwareService;

  beforeEach(() => {
    hw = new FakeHardwareService(DEFAULT_FAKE_NODES, 10_000);
  });

  afterEach(() => hw.onModuleDestroy());

  it('emits one sample per sensor-bearing node on each tick', async () => {
    const collected = firstValueFrom(hw.samples$.pipe(take(2), toArray()));
    hw.tick();
    const samples = await collected;
    expect(samples.map((s) => s.nodeId).sort()).toEqual([
      'sim-esp32',
      'sim-pi',
    ]);
  });

  it('rejects a pin the node does not expose, as a real node would', async () => {
    await expect(hw.setPin('sim-esp32', BURNER)).rejects.toThrow(
      /does not expose pin/,
    );
  });

  // Leakage is a fraction of the gradient to outside air, so the burner easily
  // out-runs it at baseline and barely beats it near the setpoint. That shape
  // is why a single CO2 threshold chattered on the real greenhouse; a flat
  // decay rate would hide it and make the dead band look unnecessary.
  it('gains CO2 far more slowly near the setpoint than at baseline', async () => {
    const atBaseline = await gainOverTicks(hw, 600, 5);

    const high = new FakeHardwareService(DEFAULT_FAKE_NODES, 10_000);
    const nearSetpoint = await gainOverTicks(high, 1450, 5);
    high.onModuleDestroy();

    expect(atBaseline).toBeGreaterThan(0);
    // The SHAPE is the point, not a fitted ratio. The field numbers are
    // internally inconsistent - decay with the burner off implies a smaller
    // leak coefficient than the observed near-setpoint gain does, most likely
    // mixing lag - so the simulator takes its constants from the cleanest
    // measurements and does not pretend to more precision than that.
    expect(nearSetpoint).toBeLessThan(atBaseline * 0.8);
  });

  // On the real burner CO2 kept falling for over two minutes after ignition
  // before it turned around - long enough to read as a failed light.
  it('ramps its output in rather than producing at full rate immediately', async () => {
    await hw.setPin('sim-pi', BURNER);
    const first = await sampleAfterTicks(hw, 1);
    const second = await sampleAfterTicks(hw, 1);
    const third = await sampleAfterTicks(hw, 1);
    expect(second.co2! - first.co2!).toBeLessThan(third.co2! - second.co2!);
  });

  it('rejects an unknown node', async () => {
    await expect(hw.setPin('nope', BURNER)).rejects.toThrow(
      /Unknown simulated node/,
    );
  });

  // The property the rules engine work depends on: this is a closed loop, so
  // "burner on -> CO2 climbs -> rule turns it off" is observable without hardware.
  it('raises CO2 while the burner is energised', async () => {
    const before = await sampleAfterTicks(hw, 1);
    await hw.setPin('sim-pi', BURNER);
    const after = await sampleAfterTicks(hw, 5);
    expect(after.co2!).toBeGreaterThan(before.co2!);
  });

  it('lowers CO2 while the fan runs and the burner is off', async () => {
    await hw.setPin('sim-pi', BURNER);
    const peak = await sampleAfterTicks(hw, 5);
    await hw.setPin('sim-pi', { pin: 5, level: 1 }); // burner off
    await hw.setPin('sim-pi', FAN);
    const after = await sampleAfterTicks(hw, 5);
    expect(after.co2!).toBeLessThan(peak.co2!);
  });

  it('raises temperature while the burner runs, since it doubles as the heater', async () => {
    const before = await sampleAfterTicks(hw, 1);
    await hw.setPin('sim-pi', BURNER);
    const after = await sampleAfterTicks(hw, 10);
    expect(after.temperature).toBeGreaterThan(before.temperature);
  });

  it('gives the second node a different reading, as a sensor at the far end would', async () => {
    const collected = firstValueFrom(hw.samples$.pipe(take(2), toArray()));
    hw.tick();
    const [a, b] = await collected;
    expect(a.temperature).not.toEqual(b.temperature);
  });

  it('increments nodeSeq per node so QoS-1 duplicates can be detected', async () => {
    const first = await sampleAfterTicks(hw, 1);
    const second = await sampleAfterTicks(hw, 1);
    expect(second.nodeSeq!).toBe(first.nodeSeq! + 1);
  });
});

/** Ticks n times and resolves with the final `sim-pi` sample. */
async function sampleAfterTicks(hw: FakeHardwareService, n: number) {
  let last!: SensorSample;
  const sub = hw.samples$.subscribe((s) => {
    if (s.nodeId === 'sim-pi') last = s;
  });
  for (let i = 0; i < n; i++) hw.tick();
  sub.unsubscribe();
  return last;
}

// The fake stands in for a real node in every local dev session, so an
// ordinary condition must not reach the client as an opaque 500. Same reasoning
// as the MQTT driver.
describe('FakeHardwareService failure codes', () => {
  it('reports an unknown node as unreachable hardware, with a typed code', async () => {
    const hw = new FakeHardwareService();
    await expect(hw.setPin('nope', BURNER)).rejects.toMatchObject({
      code: ApiErrorCode.HardwareUnreachable,
    });
  });

  it('reports a pin the node does not expose with its own code', async () => {
    const hw = new FakeHardwareService();
    await expect(hw.setPin('sim-esp32', BURNER)).rejects.toMatchObject({
      code: ApiErrorCode.PinNotAvailable,
    });
  });
});

/** Net CO2 gained over `ticks` with the burner running, from a given start. */
async function gainOverTicks(
  hw: FakeHardwareService,
  startCo2: number,
  ticks: number,
): Promise<number> {
  (hw as unknown as { co2: number }).co2 = startCo2;
  // Past the warm-up, so this measures steady output against leakage.
  (hw as unknown as { burnerMinutes: number }).burnerMinutes = 10;
  await hw.setPin('sim-pi', BURNER);
  const before = await sampleAfterTicks(hw, 1);
  const after = await sampleAfterTicks(hw, ticks);
  return after.co2! - before.co2!;
}
