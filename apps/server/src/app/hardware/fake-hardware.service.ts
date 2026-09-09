import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import {
  NodeKind,
  type NodeCapabilities,
  type NodeId,
} from '@tempestas/domain';
import {
  HardwareService,
  type NodeAvailability,
  type NodeHello,
  type PinCommand,
  type SensorSample,
} from './hardware.service';

/** Pins as wired on the real greenhouse hardware, so the sim behaves like it. */
const BURNER_PIN = 16;
const FAN_PIN = 20;
/** Four of the five relays are active-LOW, so 0 means energised. */
const ON_LEVEL_ACTIVE_LOW = 0;

export interface FakeNodeSpec {
  nodeId: NodeId;
  pins: number[];
  sensorId: string | null;
}

export const DEFAULT_FAKE_NODES: FakeNodeSpec[] = [
  { nodeId: 'sim-pi', pins: [12, 16, 20, 21, 26], sensorId: 'scd4x-0' },
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
  private readonly pinState = new Map<string, number>();
  private readonly seq = new Map<NodeId, number>();
  private timer: NodeJS.Timeout | null = null;

  private temperature = 18;
  private co2 = 600;
  private humidity = 55;
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
    const node = this.nodes.find((n) => n.nodeId === nodeId);
    if (!node) throw new Error(`Unknown simulated node ${nodeId}`);
    if (!node.pins.includes(command.pin)) {
      throw new Error(`Node ${nodeId} does not expose pin ${command.pin}`);
    }
    this.pinState.set(`${nodeId}:${command.pin}`, command.level);
  }

  async syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void> {
    for (const c of commands) await this.setPin(nodeId, c);
  }

  getPin(nodeId: NodeId, pin: number): number | undefined {
    return this.pinState.get(`${nodeId}:${pin}`);
  }

  /** Advance the simulation one step. Exposed so tests can drive it directly. */
  tick(): void {
    const burnerOn = this.getPin('sim-pi', BURNER_PIN) === ON_LEVEL_ACTIVE_LOW;
    const fanOn = this.getPin('sim-pi', FAN_PIN) === ON_LEVEL_ACTIVE_LOW;

    this.minutes = (this.minutes + 1) % (24 * 60);
    // Diurnal baseline, coldest around 05:00 and warmest around 17:00.
    const diurnal =
      18 + 7 * Math.sin(((this.minutes - 300) / 1440) * 2 * Math.PI);

    let delta = (diurnal - this.temperature) * 0.05;
    if (burnerOn) delta += 0.25;
    if (fanOn) delta -= 0.4;
    this.temperature = Math.round((this.temperature + delta) * 100) / 100;

    let co2Delta = -8;
    if (burnerOn) co2Delta += 45;
    if (fanOn) co2Delta -= 30;
    this.co2 = Math.max(400, Math.min(2500, Math.round(this.co2 + co2Delta)));

    this.humidity = Math.max(
      20,
      Math.min(95, this.humidity + (fanOn ? -0.5 : 0.2)),
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
