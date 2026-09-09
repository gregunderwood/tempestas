import { firstValueFrom, toArray, take } from 'rxjs';
import {
  DEFAULT_FAKE_NODES,
  FakeHardwareService,
} from './fake-hardware.service';
import type { SensorSample } from './hardware.service';

const BURNER = { pin: 16, level: 0 as const }; // active-LOW: 0 == energised
const FAN = { pin: 20, level: 0 as const };

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
    await hw.setPin('sim-pi', { pin: 16, level: 1 }); // burner off
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
