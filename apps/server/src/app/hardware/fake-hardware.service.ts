import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import {
  ApiErrorCode,
  NodeKind,
  type NodeCapabilities,
  type NodeId,
} from '@tempestas/domain';
import {
  HardwareError,
  HardwareService,
  type NodeAvailability,
  type NodeHello,
  type PinCommand,
  type PinStateReport,
  type SensorSample,
} from './hardware.service';
import { MINUTES_PER_DAY } from '../common/time-units';
import { toPinKey } from './pin-key';

const SIM_PI_NODE_ID = 'sim-pi';
const SIM_ESP32_NODE_ID = 'sim-esp32';

/** Pins as wired on elantris, so a device created in dev works in production. */
const BURNER_PIN = 5;
const FAN_PIN = 6;
const SPARE_RELAY_PIN = 4;
/** The relay board is active-LOW, so 0 means energised. */
const ON_LEVEL_ACTIVE_LOW = 0;

const DEFAULT_TICK_MS = 10_000;
const SIM_CONTRACT_VERSION = 1;
const SIM_AGENT_VERSION = '0.0.0-sim';

// Measured on the greenhouse on 2026-09-10: a shape model, not a fitted one.
const OUTDOOR_CO2_PPM = 420;
/** Leakage is a FRACTION of the gradient to outside air, never a flat rate. */
const LEAK_FRACTION_PER_MINUTE = 0.027;
/** Gross output once alight: ~88 ppm/min net at baseline, where leakage is small. */
const BURNER_CO2_PPM_PER_MINUTE = 91;
/** Output takes this long to show at the sensor - mixing plus warm-up. */
const BURNER_WARMUP_MINUTES = 2.5;
/** ~1 °C per 15 minutes of run time. */
const BURNER_DEG_C_PER_MINUTE = 0.067;
/** A fan clears a good share of the excess each minute. */
const FAN_CLEAR_FRACTION_PER_MINUTE = 0.25;
const FAN_COOLING_DEG_C_PER_MINUTE = 0.4;
const CO2_CEILING_PPM = 2500;
const CO2_NOISE_PPM = 4;

const START_MINUTE_OF_DAY = 6 * 60;
const DIURNAL_MEAN_DEG_C = 18;
const DIURNAL_AMPLITUDE_DEG_C = 7;
/** The coldest point of the day, 05:00. */
const DIURNAL_COLDEST_MINUTE = 300;
const TEMPERATURE_RELAXATION_PER_MINUTE = 0.05;
/** The second node sits at the other end of the greenhouse. */
const FAR_END_TEMPERATURE_OFFSET_DEG_C = -1.5;

const START_TEMPERATURE_DEG_C = 18;
const START_CO2_PPM = 600;
const START_HUMIDITY_PCT = 55;
const START_VAPOUR_PRESSURE_HPA = 11.3;

const BURNER_VAPOUR_HPA_PER_MINUTE = 0.12;
const FAN_VAPOUR_HPA_PER_MINUTE = 0.5;
const MIN_VAPOUR_PRESSURE_HPA = 4;
const MAX_VAPOUR_PRESSURE_HPA = 28;
const MIN_HUMIDITY_PCT = 20;
const MAX_HUMIDITY_PCT = 99;

/** Magnus coefficients, the same form the docs use. */
const MAGNUS_BASE_HPA = 6.112;
const MAGNUS_SLOPE = 17.62;
const MAGNUS_OFFSET_DEG_C = 243.12;

export interface FakeNodeSpec {
  nodeId: NodeId;
  pins: number[];
  sensorId: string | null;
}

export const DEFAULT_FAKE_NODES: FakeNodeSpec[] = [
  {
    nodeId: SIM_PI_NODE_ID,
    pins: [BURNER_PIN, FAN_PIN, SPARE_RELAY_PIN],
    sensorId: 'scd4x-0',
  },
  // Sensor-only, no GPIO: proves the multi-node path and the capability model.
  { nodeId: SIM_ESP32_NODE_ID, pins: [], sensorId: 'scd4x-1' },
];

// A closed loop, not a random number generator: see docs/Architecture.md.
@Injectable()
export class FakeHardwareService
  extends HardwareService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  readonly isLeader = true;

  private readonly logger = new Logger(FakeHardwareService.name);
  private readonly samples = new Subject<SensorSample>();
  private readonly availability = new Subject<NodeAvailability>();
  private readonly hello = new Subject<NodeHello>();
  private readonly pinStates = new Subject<PinStateReport>();
  private readonly levelByPin = new Map<string, number>();
  private readonly lastReports = new Map<string, PinStateReport>();
  private readonly sequenceByNode = new Map<NodeId, number>();
  private timer: NodeJS.Timeout | null = null;

  private temperature = START_TEMPERATURE_DEG_C;
  private co2 = START_CO2_PPM;
  private humidity = START_HUMIDITY_PCT;
  /** Water in the air, hPa. Humidity is derived from this and temperature. */
  private vapourPressure = START_VAPOUR_PRESSURE_HPA;
  /** Consecutive minutes the burner has been alight, for the warm-up ramp. */
  private burnerMinutes = 0;
  private minuteOfDay = START_MINUTE_OF_DAY;

  constructor(
    private readonly nodes: FakeNodeSpec[] = DEFAULT_FAKE_NODES,
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {
    super();
  }

  readonly samples$: Observable<SensorSample> = this.samples.asObservable();
  readonly availability$: Observable<NodeAvailability> =
    this.availability.asObservable();
  readonly hello$: Observable<NodeHello> = this.hello.asObservable();
  readonly pinStates$: Observable<PinStateReport> =
    this.pinStates.asObservable();

  // `hello` is not retained, so announcing before every onModuleInit has subscribed would be lost.
  onApplicationBootstrap(): void {
    this.start();
  }

  start(): void {
    if (this.timer) return;
    for (const node of this.nodes) {
      this.hello.next(this.helloFor(node));
      this.availability.next({
        nodeId: node.nodeId,
        online: true,
        at: new Date(),
      });
    }
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.logger.log(
      `Fake hardware started with ${this.nodes.length} simulated nodes`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lets tests drive an arbitrary node announcing itself, including unknown ones. */
  emitHello(hello: NodeHello): void {
    this.hello.next(hello);
  }

  emitAvailability(availability: NodeAvailability): void {
    this.availability.next(availability);
  }

  async setPin(nodeId: NodeId, command: PinCommand): Promise<void> {
    const node = this.requireExposedPin(nodeId, command.pin);
    const pinKey = toPinKey(node.nodeId, command.pin);
    this.levelByPin.set(pinKey, command.level);
    const report: PinStateReport = {
      nodeId,
      pin: command.pin,
      level: command.level,
      known: true,
      observedAt: new Date(),
      live: true,
    };
    this.lastReports.set(pinKey, report);
    this.pinStates.next(report);
  }

  lastPinReport(nodeId: NodeId, pin: number): PinStateReport | null {
    return this.lastReports.get(toPinKey(nodeId, pin)) ?? null;
  }

  async syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void> {
    for (const command of commands) await this.setPin(nodeId, command);
  }

  getPin(nodeId: NodeId, pin: number): number | undefined {
    return this.levelByPin.get(toPinKey(nodeId, pin));
  }

  // Leakage scales with the gradient to outside air; see docs/Rules and Climate.md.
  tick(): void {
    const isBurnerOn =
      this.getPin(SIM_PI_NODE_ID, BURNER_PIN) === ON_LEVEL_ACTIVE_LOW;
    const isFanOn =
      this.getPin(SIM_PI_NODE_ID, FAN_PIN) === ON_LEVEL_ACTIVE_LOW;

    this.burnerMinutes = isBurnerOn ? this.burnerMinutes + 1 : 0;
    const output = Math.min(1, this.burnerMinutes / BURNER_WARMUP_MINUTES);

    this.advanceTemperature(isBurnerOn, isFanOn, output);
    this.advanceCo2(isBurnerOn, isFanOn, output);
    this.advanceHumidity(isBurnerOn, isFanOn, output);
    this.emitSamples();
  }

  // Typed failures, so an ordinary condition in local dev is never an opaque 500.
  private requireExposedPin(nodeId: NodeId, pin: number): FakeNodeSpec {
    const node = this.nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) {
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `Unknown simulated node ${nodeId}; the fake driver only knows ` +
          this.nodes.map((known) => known.nodeId).join(', '),
      );
    }
    if (!node.pins.includes(pin)) {
      throw new HardwareError(
        ApiErrorCode.PinNotAvailable,
        `Node ${nodeId} does not expose pin ${pin}`,
      );
    }
    return node;
  }

  private helloFor(spec: FakeNodeSpec): NodeHello {
    const isEsp32 = spec.nodeId === SIM_ESP32_NODE_ID;
    const capabilities: NodeCapabilities = {
      contractVersion: SIM_CONTRACT_VERSION,
      ...(spec.pins.length
        ? { gpio: { pins: spec.pins, supportsReadback: true } }
        : {}),
      sensors: spec.sensorId
        ? [
            {
              sensorId: spec.sensorId,
              kind: 'scd4x',
              metrics: ['temperature', 'humidity', 'co2'],
              sampleIntervalMs: this.tickMs,
            },
          ]
        : [],
      hasRtc: !isEsp32,
    };
    return {
      nodeId: spec.nodeId,
      kind: isEsp32 ? NodeKind.Esp32 : NodeKind.RaspberryPi,
      agentVersion: SIM_AGENT_VERSION,
      capabilities,
      bootId: `sim-${Date.now()}`,
      receivedAt: new Date(),
    };
  }

  private advanceTemperature(
    isBurnerOn: boolean,
    isFanOn: boolean,
    output: number,
  ): void {
    this.minuteOfDay = (this.minuteOfDay + 1) % MINUTES_PER_DAY;
    let delta =
      (this.diurnalBaseline() - this.temperature) *
      TEMPERATURE_RELAXATION_PER_MINUTE;
    if (isBurnerOn) delta += BURNER_DEG_C_PER_MINUTE * output;
    if (isFanOn) delta -= FAN_COOLING_DEG_C_PER_MINUTE;
    this.temperature = Math.round((this.temperature + delta) * 100) / 100;
  }

  private diurnalBaseline(): number {
    const phase = (this.minuteOfDay - DIURNAL_COLDEST_MINUTE) / MINUTES_PER_DAY;
    return (
      DIURNAL_MEAN_DEG_C +
      DIURNAL_AMPLITUDE_DEG_C * Math.sin(phase * 2 * Math.PI)
    );
  }

  private advanceCo2(
    isBurnerOn: boolean,
    isFanOn: boolean,
    output: number,
  ): void {
    const excess = this.co2 - OUTDOOR_CO2_PPM;
    let co2Delta = -excess * LEAK_FRACTION_PER_MINUTE;
    if (isBurnerOn) co2Delta += BURNER_CO2_PPM_PER_MINUTE * output;
    if (isFanOn) co2Delta -= excess * FAN_CLEAR_FRACTION_PER_MINUTE;
    this.co2 = clamp(
      Math.round(this.co2 + co2Delta + jitter(CO2_NOISE_PPM)),
      OUTDOOR_CO2_PPM,
      CO2_CEILING_PPM,
    );
  }

  // Derived from the water in the air, so RH falls as the burner warms it, as on the real sensor.
  private advanceHumidity(
    isBurnerOn: boolean,
    isFanOn: boolean,
    output: number,
  ): void {
    if (isBurnerOn)
      this.vapourPressure += BURNER_VAPOUR_HPA_PER_MINUTE * output;
    if (isFanOn) this.vapourPressure -= FAN_VAPOUR_HPA_PER_MINUTE;
    this.vapourPressure = clamp(
      this.vapourPressure,
      MIN_VAPOUR_PRESSURE_HPA,
      MAX_VAPOUR_PRESSURE_HPA,
    );
    this.humidity = clamp(
      (100 * this.vapourPressure) / saturationPressure(this.temperature),
      MIN_HUMIDITY_PCT,
      MAX_HUMIDITY_PCT,
    );
  }

  private emitSamples(): void {
    for (const node of this.nodes) {
      if (!node.sensorId) continue;
      const nodeSeq = (this.sequenceByNode.get(node.nodeId) ?? 0) + 1;
      this.sequenceByNode.set(node.nodeId, nodeSeq);
      this.samples.next({
        nodeId: node.nodeId,
        sensorId: node.sensorId,
        receivedAt: new Date(),
        temperature:
          node.nodeId === SIM_ESP32_NODE_ID
            ? this.temperature + FAR_END_TEMPERATURE_OFFSET_DEG_C
            : this.temperature,
        humidity: Math.round(this.humidity * 10) / 10,
        co2: this.co2,
        nodeSeq,
      });
    }
  }
}

/** Saturation vapour pressure, hPa. */
function saturationPressure(temperatureDegC: number): number {
  return (
    MAGNUS_BASE_HPA *
    Math.exp(
      (MAGNUS_SLOPE * temperatureDegC) /
        (MAGNUS_OFFSET_DEG_C + temperatureDegC),
    )
  );
}

/** Small measurement noise, so a gauge moves the way a real one does. */
function jitter(amplitude: number): number {
  return (Math.random() - 0.5) * 2 * amplitude;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
