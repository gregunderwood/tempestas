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

/** Pins as wired on elantris, so a device created in dev works in production. */
const BURNER_PIN = 5;
const FAN_PIN = 6;
/** The relay board is active-LOW, so 0 means energised. */
const ON_LEVEL_ACTIVE_LOW = 0;

/**
 * Constants from the greenhouse on 2026-09-10 with the real generator, not
 * invented - but a shape model, not a fitted one. The field numbers are
 * internally inconsistent (decay with the burner off implies a smaller leak
 * coefficient than the observed gain near the setpoint does, most likely
 * mixing lag between the burner and the sensor), so these come from the
 * cleanest measurements and claim no more precision than that.
 */
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

/** Saturation vapour pressure, hPa. Magnus, the same form the docs use. */
function saturationPressure(tempC: number): number {
  return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

export interface FakeNodeSpec {
  nodeId: NodeId;
  pins: number[];
  sensorId: string | null;
}

export const DEFAULT_FAKE_NODES: FakeNodeSpec[] = [
  // elantris's own wiring: BCM 5 -> In6 (the CO2 generator), 6 -> In7, 4 -> In8.
  // Matching it means a device created against the sim works unchanged against
  // the real panel.
  { nodeId: 'sim-pi', pins: [5, 6, 4], sensorId: 'scd4x-0' },
  // Deliberately different shape: sensor-only, no GPIO. Proves the multi-node
  // path and the capability model with zero hardware.
  { nodeId: 'sim-esp32', pins: [], sensorId: 'scd4x-1' },
];

/**
 * A CLOSED-LOOP simulator, not a random number generator.
 *
 * Temperature follows a diurnal curve, pushed up by the burner and pulled down
 * by the exhaust fan; CO2 climbs while the burner runs and falls while the fan
 * does. That makes the real rules engine observably work end-to-end with no
 * hardware: burner on -> CO2 climbs -> rule turns it off.
 */
@Injectable()
export class FakeHardwareService
  extends HardwareService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FakeHardwareService.name);
  private readonly samples = new Subject<SensorSample>();
  private readonly availability = new Subject<NodeAvailability>();
  private readonly hello = new Subject<NodeHello>();
  private readonly pinStates = new Subject<PinStateReport>();
  private readonly pinState = new Map<string, number>();
  private readonly seq = new Map<NodeId, number>();
  private timer: NodeJS.Timeout | null = null;

  private temperature = 18;
  private co2 = 600;
  private humidity = 55;
  /** Water in the air, hPa. Humidity is derived from this and temperature. */
  private vapourPressure = 11.3;
  /** Consecutive minutes the burner has been alight, for the warm-up ramp. */
  private burnerMinutes = 0;
  private minutes = 6 * 60;

  constructor(
    private readonly nodes: FakeNodeSpec[] = DEFAULT_FAKE_NODES,
    private readonly tickMs = 10_000,
  ) {
    super();
  }

  readonly samples$: Observable<SensorSample> = this.samples.asObservable();
  readonly availability$: Observable<NodeAvailability> =
    this.availability.asObservable();
  readonly hello$: Observable<NodeHello> = this.hello.asObservable();
  readonly pinStates$: Observable<PinStateReport> =
    this.pinStates.asObservable();

  /**
   * Announcing happens here, not in the provider factory, and the distinction
   * matters: `hello` is NOT retained on the real broker, so a subscriber that
   * attaches late never sees it. Nest runs every onModuleInit - including the
   * registry's subscription - before any onApplicationBootstrap, which is the
   * only ordering that makes the fake driver faithful to that.
   */
  onApplicationBootstrap(): void {
    this.start();
  }

  start(): void {
    if (this.timer) return;
    for (const n of this.nodes) {
      this.hello.next(this.helloFor(n));
      this.availability.next({
        nodeId: n.nodeId,
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

  private helloFor(spec: FakeNodeSpec): NodeHello {
    const capabilities: NodeCapabilities = {
      contractVersion: 1,
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
      hasRtc: spec.nodeId !== 'sim-esp32',
    };
    return {
      nodeId: spec.nodeId,
      kind: spec.nodeId === 'sim-esp32' ? NodeKind.Esp32 : NodeKind.RaspberryPi,
      agentVersion: '0.0.0-sim',
      capabilities,
      bootId: `sim-${Date.now()}`,
      receivedAt: new Date(),
    };
  }

  async setPin(nodeId: NodeId, command: PinCommand): Promise<void> {
    // Typed failures, for the same reason the MQTT driver has them: a fake that
    // throws a bare Error turns an ordinary condition into an opaque 500, and
    // this is the driver every developer runs against locally.
    const node = this.nodes.find((n) => n.nodeId === nodeId);
    if (!node) {
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `Unknown simulated node ${nodeId}; the fake driver only knows ` +
          this.nodes.map((n) => n.nodeId).join(', '),
      );
    }
    if (!node.pins.includes(command.pin)) {
      throw new HardwareError(
        ApiErrorCode.PinNotAvailable,
        `Node ${nodeId} does not expose pin ${command.pin}`,
      );
    }
    this.pinState.set(`${nodeId}:${command.pin}`, command.level);
    // A real node reports every line change, so the fake does too - otherwise
    // the reconciliation path has no coverage in local dev, which is where the
    // whole point of this driver is that it behaves like the real one.
    this.pinStates.next({
      nodeId,
      pin: command.pin,
      level: command.level,
      known: true,
      observedAt: new Date(),
    });
  }

  async syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void> {
    for (const c of commands) await this.setPin(nodeId, c);
  }

  getPin(nodeId: NodeId, pin: number): number | undefined {
    return this.pinState.get(`${nodeId}:${pin}`);
  }

  /** Small measurement noise, so a gauge moves the way a real one does. */
  private jitter(amplitude: number): number {
    return (Math.random() - 0.5) * 2 * amplitude;
  }

  /**
   * Advance the simulation one minute. Exposed so tests can drive it directly.
   *
   * The behaviour that matters for development is the SHAPE, and the shape is
   * set by one fact: leakage is proportional to the gradient to outside air. So
   * the burner easily out-runs it near baseline and barely beats it near the
   * setpoint, which is why a single CO2 threshold chattered on the real
   * greenhouse and a dead band was needed. A simulator with a flat decay rate
   * hides exactly that, and would have made the fix look unnecessary.
   */
  tick(): void {
    const burnerOn = this.getPin('sim-pi', BURNER_PIN) === ON_LEVEL_ACTIVE_LOW;
    const fanOn = this.getPin('sim-pi', FAN_PIN) === ON_LEVEL_ACTIVE_LOW;

    // Output ramps in rather than appearing at full rate: on the real burner
    // CO2 kept FALLING for over two minutes after ignition before it turned
    // around, which is long enough to read as a failed light if unmodelled.
    this.burnerMinutes = burnerOn ? this.burnerMinutes + 1 : 0;
    const output = Math.min(1, this.burnerMinutes / BURNER_WARMUP_MINUTES);

    this.minutes = (this.minutes + 1) % (24 * 60);
    // Diurnal baseline, coldest around 05:00 and warmest around 17:00.
    const diurnal =
      18 + 7 * Math.sin(((this.minutes - 300) / 1440) * 2 * Math.PI);

    let delta = (diurnal - this.temperature) * 0.05;
    if (burnerOn) delta += BURNER_DEG_C_PER_MINUTE * output;
    if (fanOn) delta -= 0.4;
    this.temperature = Math.round((this.temperature + delta) * 100) / 100;

    const excess = this.co2 - OUTDOOR_CO2_PPM;
    let co2Delta = -excess * LEAK_FRACTION_PER_MINUTE;
    if (burnerOn) co2Delta += BURNER_CO2_PPM_PER_MINUTE * output;
    if (fanOn) co2Delta -= excess * FAN_CLEAR_FRACTION_PER_MINUTE;
    this.co2 = Math.max(
      OUTDOOR_CO2_PPM,
      Math.min(2500, Math.round(this.co2 + co2Delta + this.jitter(4))),
    );

    // Humidity is derived from the water in the air and the temperature, not
    // tracked directly. That reproduces the relationship the real sensor
    // showed - RH falling as the burner warms the air even though combustion
    // is ADDING water - and it is the same physics the offset calibration
    // leans on.
    if (burnerOn) this.vapourPressure += 0.12 * output;
    if (fanOn) this.vapourPressure -= 0.5;
    this.vapourPressure = Math.max(4, Math.min(28, this.vapourPressure));
    this.humidity = Math.max(
      20,
      Math.min(
        99,
        (100 * this.vapourPressure) / saturationPressure(this.temperature),
      ),
    );

    for (const node of this.nodes) {
      if (!node.sensorId) continue;
      const n = (this.seq.get(node.nodeId) ?? 0) + 1;
      this.seq.set(node.nodeId, n);
      this.samples.next({
        nodeId: node.nodeId,
        sensorId: node.sensorId,
        receivedAt: new Date(),
        // The second node sits at the other end of the greenhouse.
        temperature:
          node.nodeId === 'sim-esp32'
            ? this.temperature - 1.5
            : this.temperature,
        humidity: Math.round(this.humidity * 10) / 10,
        co2: this.co2,
        nodeSeq: n,
      });
    }
  }
}
