import { firstValueFrom, toArray, take } from 'rxjs';
import { AgentApp, ApiErrorCode, UpdateState } from '@tempestas/domain';
import {
  DEFAULT_FAKE_NODES,
  FakeHardwareService,
} from './fake-hardware.service';
import type { NodeHello, SensorSample } from './hardware.service';

// elantris's own wiring: BCM 5 is the CO2 generator. Active-LOW, so 0 is on.
const BURNER = { pin: 5, level: 0 as const };
const FAN = { pin: 6, level: 0 as const };
const TICK_MS = 10_000;
// Past the warm-up, so a gain measures steady output against leakage.
const WARMED_UP_BURNER_MINUTES = 10;

describe('FakeHardwareService', () => {
  let hardware: FakeHardwareService;

  beforeEach(() => {
    hardware = new FakeHardwareService(DEFAULT_FAKE_NODES, TICK_MS);
  });

  afterEach(() => hardware.onModuleDestroy());

  it('emits one sample per sensor-bearing node on each tick', async () => {
    const collected = firstValueFrom(
      hardware.samples$.pipe(take(2), toArray()),
    );
    hardware.tick();
    const samples = await collected;
    expect(samples.map((sample) => sample.nodeId).sort()).toEqual([
      'sim-esp32',
      'sim-pi',
    ]);
  });

  it('rejects a pin the node does not expose, as a real node would', async () => {
    await expect(hardware.setPin('sim-esp32', BURNER)).rejects.toThrow(
      /does not expose pin/,
    );
  });

  // The shape that made a single CO2 threshold chatter on the real greenhouse.
  it('gains CO2 far more slowly near the setpoint than at baseline', async () => {
    const atBaseline = await gainOverTicks(600, 5);
    const nearSetpoint = await gainOverTicks(1450, 5);

    expect(atBaseline).toBeGreaterThan(0);
    // The shape is the point, not a fitted ratio; see docs/Architecture.md.
    expect(nearSetpoint).toBeLessThan(atBaseline * 0.8);
  });

  // On the real burner CO2 kept falling for over two minutes after ignition.
  it('ramps its output in rather than producing at full rate immediately', async () => {
    await hardware.setPin('sim-pi', BURNER);
    const first = await sampleAfterTicks(hardware, 1);
    const second = await sampleAfterTicks(hardware, 1);
    const third = await sampleAfterTicks(hardware, 1);
    expect(co2Of(second) - co2Of(first)).toBeLessThan(
      co2Of(third) - co2Of(second),
    );
  });

  it('rejects an unknown node', async () => {
    await expect(hardware.setPin('nope', BURNER)).rejects.toThrow(
      /Unknown simulated node/,
    );
  });

  // The closed loop the rules engine depends on.
  it('raises CO2 while the burner is energised', async () => {
    const before = await sampleAfterTicks(hardware, 1);
    await hardware.setPin('sim-pi', BURNER);
    const after = await sampleAfterTicks(hardware, 5);
    expect(co2Of(after)).toBeGreaterThan(co2Of(before));
  });

  it('lowers CO2 while the fan runs and the burner is off', async () => {
    await hardware.setPin('sim-pi', BURNER);
    const peak = await sampleAfterTicks(hardware, 5);
    await hardware.setPin('sim-pi', { pin: 5, level: 1 }); // burner off
    await hardware.setPin('sim-pi', FAN);
    const after = await sampleAfterTicks(hardware, 5);
    expect(co2Of(after)).toBeLessThan(co2Of(peak));
  });

  it('raises temperature while the burner runs, since it doubles as the heater', async () => {
    const before = await sampleAfterTicks(hardware, 1);
    await hardware.setPin('sim-pi', BURNER);
    const after = await sampleAfterTicks(hardware, 10);
    expect(after.temperature).toBeGreaterThan(before.temperature);
  });

  it('gives the second node a different reading, as a sensor at the far end would', async () => {
    const collected = firstValueFrom(
      hardware.samples$.pipe(take(2), toArray()),
    );
    hardware.tick();
    const [nearSample, farSample] = await collected;
    expect(nearSample.temperature).not.toEqual(farSample.temperature);
  });

  it('increments nodeSeq per node so QoS-1 duplicates can be detected', async () => {
    const first = await sampleAfterTicks(hardware, 1);
    const second = await sampleAfterTicks(hardware, 1);
    expect(second.nodeSeq).toBe(nodeSeqOf(first) + 1);
  });
});

/** Ticks `ticks` times and resolves with the final `sim-pi` sample. */
async function sampleAfterTicks(
  hardware: FakeHardwareService,
  ticks: number,
): Promise<SensorSample> {
  let last: SensorSample | undefined;
  const subscription = hardware.samples$.subscribe((sample) => {
    if (sample.nodeId === 'sim-pi') last = sample;
  });
  for (let tick = 0; tick < ticks; tick++) hardware.tick();
  subscription.unsubscribe();
  if (!last) throw new Error(`sim-pi emitted no sample in ${ticks} ticks`);
  return last;
}

function co2Of(sample: SensorSample): number {
  if (sample.co2 === null) throw new Error('the simulated sensor had no CO2');
  return sample.co2;
}

function nodeSeqOf(sample: SensorSample): number {
  if (sample.nodeSeq === null) throw new Error('the sample had no nodeSeq');
  return sample.nodeSeq;
}

// An ordinary condition in local dev must not reach the client as an opaque 500.
describe('FakeHardwareService failure codes', () => {
  it('reports an unknown node as unreachable hardware, with a typed code', async () => {
    const hardware = new FakeHardwareService();
    await expect(hardware.setPin('nope', BURNER)).rejects.toMatchObject({
      code: ApiErrorCode.HardwareUnreachable,
    });
  });

  it('reports a pin the node does not expose with its own code', async () => {
    const hardware = new FakeHardwareService();
    await expect(hardware.setPin('sim-esp32', BURNER)).rejects.toMatchObject({
      code: ApiErrorCode.PinNotAvailable,
    });
  });
});

/** Net CO2 gained over `ticks` with a warmed-up burner running, from a given start. */
async function gainOverTicks(startCo2: number, ticks: number): Promise<number> {
  const hardware = new FakeHardwareService(DEFAULT_FAKE_NODES, TICK_MS, {
    co2Ppm: startCo2,
    burnerMinutes: WARMED_UP_BURNER_MINUTES,
  });
  await hardware.setPin('sim-pi', BURNER);
  const before = await sampleAfterTicks(hardware, 1);
  const after = await sampleAfterTicks(hardware, ticks);
  hardware.onModuleDestroy();
  return co2Of(after) - co2Of(before);
}

describe('FakeHardwareService updates', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('plays an update through to healthy, restarting on the new version', async () => {
    const hardware = new FakeHardwareService(DEFAULT_FAKE_NODES, TICK_MS);
    const states: UpdateState[] = [];
    const hellos: NodeHello[] = [];
    hardware.updateStatuses$.subscribe((status) => states.push(status.state));
    hardware.hello$.subscribe((hello) => hellos.push(hello));

    await hardware.sendUpdate('sim-pi', {
      id: 'update-1',
      app: AgentApp.Linux,
      version: '1.2.1',
      manifestUrl: 'http://localhost/manifest.json',
      manifestSha256: 'c'.repeat(64),
    });
    await vi.runAllTimersAsync();

    expect(states).toEqual([
      UpdateState.Downloading,
      UpdateState.Verifying,
      UpdateState.Installing,
      UpdateState.Restarting,
      UpdateState.Healthy,
    ]);
    expect(hellos.map((hello) => hello.agentVersion)).toEqual(['1.2.1']);
    hardware.onModuleDestroy();
  });
});
