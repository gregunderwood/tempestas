import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, type IClientOptions, type MqttClient } from 'mqtt';
import { Subject, type Observable } from 'rxjs';
import {
  AlarmCode,
  ApiErrorCode,
  MQTT_ROOT,
  mqttQos,
  mqttTopics,
  type GpioLevel,
  type GpioResultPayload,
  type NodeId,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import {
  type ControllerRole,
  resolveControllerRole,
} from '../common/controller-role';
import {
  HardwareError,
  HardwareService,
  type NodeAvailability,
  type NodeHello,
  type PinStateReport,
  type PinCommand,
  type SensorSample,
} from './hardware.service';
import {
  buildGpioSet,
  buildGpioSync,
  buildStatus,
  decodeAlarm,
  decodeGpioState,
  decodeHello,
  decodeResult,
  decodeSample,
  decodeStatus,
  parseJson,
  parseNodeTopic,
  toGpioLines,
  verifyResult,
} from './mqtt-codec';

/** How long a node has to acknowledge a pin write before it is a failure. */
const COMMAND_TIMEOUT_MS = 5_000;
/**
 * How long a command stays valid on the wire. Longer than the ack timeout so a
 * slow-but-successful node is not obeying something we already gave up on, and
 * short enough that a queued or replayed command is refused rather than acted on.
 */
const COMMAND_TTL_MS = 15_000;
/** The node's dead-man counts these. Missing them is what makes it fail safe. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** One log line per node per reason per window, so a broken node cannot spam. */
const WARN_THROTTLE_MS = 5 * 60 * 1000;

interface PendingCommand {
  nodeId: NodeId;
  commands: readonly PinCommand[];
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * The real hardware driver: the only place in the application that imports
 * `mqtt`.
 *
 * Everything decidable without a socket lives in `mqtt-codec.ts` as pure
 * functions, so what remains here is connection lifecycle, subscription routing
 * and command correlation. That split is deliberate - this is the component
 * that turns a network message into a relay command on a propane burner, and it
 * should be short enough to read in one sitting.
 *
 * Three properties this class is responsible for holding:
 *
 *   1. Commands are NEVER retained, and every one carries `expiresAt`. A
 *      retained `gpio/set` would replay a burner-on command on every reconnect.
 *   2. `setPin` resolves only on a matching READBACK. The old system logged a
 *      failed GPIO write and updated the database anyway.
 *   3. The server publishes its own LWT, so every node fails safe when the
 *      brain dies - not just the one that noticed.
 */
@Injectable()
export class MqttHardwareService
  extends HardwareService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MqttHardwareService.name);
  private readonly samples = new Subject<SensorSample>();
  private readonly availability = new Subject<NodeAvailability>();
  private readonly hello = new Subject<NodeHello>();
  private readonly pinStates = new Subject<PinStateReport>();

  readonly samples$: Observable<SensorSample> = this.samples.asObservable();
  readonly pinStates$: Observable<PinStateReport> =
    this.pinStates.asObservable();
  readonly availability$: Observable<NodeAvailability> =
    this.availability.asObservable();
  readonly hello$: Observable<NodeHello> = this.hello.asObservable();

  private client: MqttClient | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pins = new Map<
    string,
    { level: GpioLevel | null; known: boolean }
  >();
  private readonly online = new Map<NodeId, boolean>();
  private readonly nodes = new Set<NodeId>();
  private readonly warnedAt = new Map<string, number>();
  private heartbeat: NodeJS.Timeout | null = null;
  private commandCount = 0;

  /** Identifies this controller, so a second one taking over is detectable. */
  private readonly controllerId = `nestjs-${process.pid}`;
  private readonly epoch: number;

  /**
   * A follower ingests everything and commands nothing. It does not heartbeat,
   * so no node ever binds to it, and it does not register a server LWT - a
   * follower dying must not tell every node to fail safe.
   */
  private readonly role: ControllerRole;

  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {
    super();
    this.epoch = this.clock.now().getTime();
    this.role = resolveControllerRole(this.config.get<string>('CONTROLLER_ROLE'), true);
  }

  get isLeader(): boolean {
    return this.role === 'leader';
  }

  /**
   * Connecting happens here rather than in the constructor for the same reason
   * the fake driver announces here: Nest runs every `onModuleInit` first, so the
   * node registry is already subscribed when the first retained `status` and the
   * first `hello` arrive.
   */
  onApplicationBootstrap(): void {
    const url = this.config.get<string>('MQTT_URL', 'mqtt://127.0.0.1:1883');
    const username = this.config.get<string>('MQTT_USERNAME', '');
    const password = this.config.get<string>('MQTT_PASSWORD', '');

    const options: IClientOptions = {
      clientId: `tempestas-server-${process.pid}`,
      // A persistent session is precisely a queue of commands waiting to replay
      // on reconnect. For a relay that may be holding a burner, that is a
      // hazard rather than a convenience.
      clean: true,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      // The server's own dead-man. Every node fails safe when the brain dies.
      //
      // Only the LEADER registers it. A follower crashing is not a reason for
      // the greenhouse to shut down, and its retained "offline" would sit on
      // the topic telling nodes exactly that.
      ...(this.isLeader
        ? {
            will: {
              topic: mqttTopics.serverStatus,
              payload: Buffer.from(
                JSON.stringify(buildStatus('server', 'offline', this.clock.now())),
              ),
              qos: mqttQos.serverStatus.qos,
              retain: mqttQos.serverStatus.retain,
            },
          }
        : {}),
    };

    const client = connect(url, options);
    this.client = client;

    client.on('connect', () => {
      this.logger.log(`Connected to ${url} as ${options.clientId}`);
      void this.announceServerOnline();
      client.subscribe(mqttTopics.allNodes, { qos: 1 }, (err) => {
        if (err) {
          this.logger.error(
            `Failed to subscribe to ${mqttTopics.allNodes}: ${err.message}`,
          );
          return;
        }
        this.logger.log(`Subscribed to ${mqttTopics.allNodes}`);
      });
      this.startHeartbeat();
    });

    client.on('message', (topic, payload, packet) => {
      this.route(topic, payload, packet.retain === true);
    });

    client.on('error', (err) =>
      this.logger.error(`MQTT error: ${err.message}`),
    );
    client.on('reconnect', () =>
      this.logger.warn('Reconnecting to the broker'),
    );
    client.on('close', () => this.logger.warn('Broker connection closed'));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;

    for (const [id, command] of this.pending) {
      clearTimeout(command.timer);
      command.reject(new Error('Server is shutting down'));
      this.pending.delete(id);
    }

    const client = this.client;
    this.client = null;
    if (!client) return;

    // Publish the offline status explicitly rather than relying on the will, so
    // every node's dead-man fires deterministically on a clean shutdown instead
    // of after a keepalive timeout.
    try {
      await client.publishAsync(
        mqttTopics.serverStatus,
        JSON.stringify(buildStatus('server', 'offline', this.clock.now())),
        mqttQos.serverStatus,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Could not publish the offline status: ${describe(err)}`,
      );
    }
    await client.endAsync();
  }

  async setPin(nodeId: NodeId, command: PinCommand): Promise<void> {
    this.refuseIfFollower('set a pin');
    return this.dispatch(nodeId, [command]);
  }

  /**
   * Refuse locally rather than publishing something the node will reject.
   *
   * A follower's command would be denied at the actuator anyway - its
   * `issuedBy` is not the bound controller - but that arrives as a
   * CONTROLLER_CONFLICT alarm, which is a real incident signal. Manual clicks
   * on a follower's UI must not manufacture one.
   */
  private refuseIfFollower(action: string): void {
    if (this.isLeader) return;
    throw new HardwareError(
      ApiErrorCode.ControllerIsFollower,
      `This server is a follower and cannot ${action}. Promote it first.`,
    );
  }

  /**
   * Re-assert the full desired state of a node's pins.
   *
   * Level-triggered rather than edge-triggered: any missed message self-heals on
   * the next assertion. There is no result topic for a sync, so this resolves
   * once the broker has accepted the publish - the per-pin truth comes back on
   * the retained `gpio/state` topics.
   */
  async syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void> {
    this.refuseIfFollower('sync pins');
    const client = this.requireClient();
    const payload = buildGpioSync(
      { nodeId, now: this.clock.now() },
      this.controllerId,
      this.epoch,
      toGpioLines(commands),
      false,
    );
    await client.publishAsync(
      mqttTopics.gpioSync(nodeId),
      JSON.stringify(payload),
      mqttQos.gpioSync,
    );
  }

  /** Last known level per pin. `known: false` means unknown, NOT off. */
  pinState(
    nodeId: NodeId,
    pin: number,
  ): { level: GpioLevel | null; known: boolean } {
    return this.pins.get(`${nodeId}:${pin}`) ?? { level: null, known: false };
  }

  private async dispatch(
    nodeId: NodeId,
    commands: readonly PinCommand[],
  ): Promise<void> {
    const client = this.requireClient();

    // Only a POSITIVE offline is refused here. A node we have not heard from
    // yet may simply not have published its retained status before the first
    // command; the ack timeout is what catches a node that is really gone, and
    // it fails without persisting any state.
    if (this.online.get(nodeId) === false) {
      throw new HardwareError(
        ApiErrorCode.NodeOffline,
        `Node "${nodeId}" is offline; its last will has fired`,
      );
    }

    const id = `${this.controllerId}-${++this.commandCount}`;
    const payload = buildGpioSet(
      { nodeId, now: this.clock.now() },
      id,
      this.controllerId,
      toGpioLines(commands),
      COMMAND_TTL_MS,
    );

    // Registered BEFORE the publish: a fast node can answer before `publishAsync`
    // resolves, and that result must not arrive to an empty table.
    const ack = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HardwareError(
            ApiErrorCode.HardwareUnreachable,
            `Node "${nodeId}" did not acknowledge command ${id} within ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { nodeId, commands, resolve, reject, timer });
    });

    try {
      await client.publishAsync(
        mqttTopics.gpioSet(nodeId),
        JSON.stringify(payload),
        mqttQos.gpioSet,
      );
    } catch (err: unknown) {
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
      }
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `Could not publish to "${nodeId}": ${describe(err)}`,
      );
    }
    return ack;
  }

  private route(topic: string, payload: Buffer, retained: boolean): void {
    const parsed = parseNodeTopic(topic);
    if (!parsed) {
      // The server's own status topic, and anything else outside the node tree.
      return;
    }

    if (parsed.kind === 'gpio-set' || parsed.kind === 'gpio-sync') {
      this.inspectCommand(topic, parsed.nodeId, parsed.kind, payload, retained);
      return;
    }
    if (parsed.kind === 'heartbeat' || parsed.kind === 'unknown') {
      return;
    }

    const json = parseJson(payload);
    // `=== false`, not `!`: an equality check against the literal is what
    // narrows these result unions under this TS config.
    if (json.ok === false) {
      // An empty payload on a retained topic is a CLEAR, which is normal.
      if (!(retained && json.reason === 'empty payload')) {
        this.warnThrottled(
          `${parsed.nodeId}:${parsed.kind}:json`,
          `${topic}: ${json.reason}`,
        );
      }
      return;
    }

    const now = this.clock.now();
    this.nodes.add(parsed.nodeId);

    switch (parsed.kind) {
      case 'hello': {
        const decoded = decodeHello(json.value, parsed.nodeId, now);
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:hello`,
            `Rejected hello from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.hello.next(decoded.value);
        return;
      }
      case 'status': {
        const decoded = decodeStatus(json.value, parsed.nodeId, now);
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:status`,
            `Rejected status from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.online.set(parsed.nodeId, decoded.value.online);
        // Stale is not off: when a node drops, every pin we thought we knew
        // becomes unknown until a fresh retained state or a successful sync.
        if (!decoded.value.online) this.forgetPins(parsed.nodeId);
        this.availability.next(decoded.value);
        return;
      }
      case 'sample': {
        const decoded = decodeSample(
          json.value,
          parsed.nodeId,
          parsed.sensorId ?? 'unknown',
          now,
        );
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:sample`,
            `Dropped sample from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.samples.next(decoded.value);
        return;
      }
      case 'gpio-state': {
        const decoded = decodeGpioState(json.value, parsed.pin ?? -1);
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:state`,
            `Rejected gpio/state from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.pins.set(`${parsed.nodeId}:${decoded.value.pin}`, {
          level: decoded.value.level,
          known: decoded.value.known,
        });
        this.pinStates.next({
          nodeId: parsed.nodeId,
          pin: decoded.value.pin,
          level: decoded.value.level,
          known: decoded.value.known,
          observedAt: decoded.value.observedAt,
        });
        return;
      }
      case 'gpio-result': {
        const decoded = decodeResult(json.value);
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:result`,
            `Rejected gpio/result from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.settle(parsed.nodeId, decoded.value);
        return;
      }
      case 'alarm': {
        const decoded = decodeAlarm(json.value);
        if (decoded.ok === false) {
          this.warnThrottled(
            `${parsed.nodeId}:alarm`,
            `Rejected alarm from "${parsed.nodeId}": ${decoded.reason}`,
          );
          return;
        }
        this.logAlarm(
          parsed.nodeId,
          decoded.value.code,
          decoded.value.severity,
          decoded.value.message,
        );
        return;
      }
    }
  }

  private settle(nodeId: NodeId, result: GpioResultPayload): void {
    const command = this.pending.get(result.id);
    if (!command) {
      // A result for a command we already timed out, or one issued by another
      // controller. Worth knowing about, not worth acting on.
      this.logger.debug(`Unmatched gpio/result ${result.id} from "${nodeId}"`);
      return;
    }
    clearTimeout(command.timer);
    this.pending.delete(result.id);

    // Record what the node actually read back, whatever the verdict.
    for (const line of result.lines) {
      this.pins.set(`${nodeId}:${line.pin}`, {
        level: line.readback,
        known: line.readback === 0 || line.readback === 1,
      });
    }

    const bad = verifyResult(result, command.commands);
    if (bad) {
      this.logAlarm(nodeId, AlarmCode.ReadbackMismatch, 'critical', bad.reason);
      command.reject(
        new HardwareError(ApiErrorCode.ReadbackMismatch, bad.reason),
      );
      return;
    }
    command.resolve();
  }

  /**
   * We are the ONLY legitimate publisher of commands, so anything on a command
   * topic that we did not issue is a controller conflict.
   *
   * This checks ownership rather than the retain flag, and that distinction
   * matters: MQTT sets the retain flag on a delivered PUBLISH only when it
   * arrives BECAUSE OF a new subscription. A retained command published while
   * everyone is already connected arrives with retain=0, looks exactly like a
   * legitimate command, and then lurks retained to replay on every future
   * reconnect. Verified against a real broker - the retain flag alone missed it.
   *
   * Either way the retained slot is cleared: a zero-length retained publish
   * deletes it, and leaving a live burner command on the bus is strictly worse
   * than removing something we did not create.
   */
  private inspectCommand(
    topic: string,
    nodeId: NodeId,
    kind: 'gpio-set' | 'gpio-sync',
    payload: Buffer,
    retained: boolean,
  ): void {
    // An empty payload IS the clear. Never react to one, or clearing a rogue
    // command becomes a publish loop against ourselves.
    if (payload.toString('utf8').trim() === '') {
      return;
    }

    const json = parseJson(payload);
    if (json.ok === false) {
      if (retained)
        this.clearRetainedCommand(topic, nodeId, `unparseable ${kind}`);
      return;
    }

    const issuer =
      kind === 'gpio-set' ? json.value['issuedBy'] : json.value['controller'];
    if (issuer === this.controllerId) {
      // Our own command, echoed back by our own subscription.
      return;
    }

    if (!this.shouldAct(`conflict:${topic}`, 10_000)) {
      return;
    }
    this.logAlarm(
      nodeId,
      AlarmCode.ControllerConflict,
      'critical',
      `Foreign ${kind} on ${topic} issued by "${String(issuer)}"` +
        `${retained ? ' (delivered RETAINED)' : ''} - this server is the only legitimate publisher`,
    );
    this.clearRetainedCommand(topic, nodeId, kind);
  }

  private clearRetainedCommand(
    topic: string,
    nodeId: NodeId,
    what: string,
  ): void {
    this.client?.publish(topic, '', { qos: 1, retain: true }, (err) => {
      if (err)
        this.logger.error(
          `Failed to clear the retained ${what} on ${topic}: ${err.message}`,
        );
      else
        this.logger.warn(
          `Cleared the retained slot on ${topic} (${what}, node "${nodeId}")`,
        );
    });
  }

  /** True at most once per window for a given key. Stops a remediation storm. */
  private shouldAct(key: string, windowMs: number): boolean {
    const nowMs = this.clock.now().getTime();
    const last = this.warnedAt.get(key);
    if (last !== undefined && nowMs - last < windowMs) return false;
    this.warnedAt.set(key, nowMs);
    return true;
  }

  private forgetPins(nodeId: NodeId): void {
    for (const key of this.pins.keys()) {
      if (key.startsWith(`${nodeId}:`)) {
        this.pins.set(key, { level: null, known: false });
      }
    }
  }

  private async announceServerOnline(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.publishAsync(
        mqttTopics.serverStatus,
        JSON.stringify(buildStatus('server', 'online', this.clock.now())),
        mqttQos.serverStatus,
      );
    } catch (err: unknown) {
      this.logger.warn(
        `Could not announce the server as online: ${describe(err)}`,
      );
    }
  }

  /**
   * The input to every node's dead-man. QoS 0 deliberately: a missed heartbeat
   * must LOOK missed rather than being redelivered late, because "late" is
   * indistinguishable from "the controller is alive" to a node counting them.
   */
  private startHeartbeat(): void {
    if (this.heartbeat) return;
    if (!this.isLeader) {
      // The binding a heartbeat creates is the right to command. A follower
      // must never create one, or the node starts obeying two controllers.
      this.logger.log('Follower: not heartbeating, so no node will bind to this server');
      return;
    }
    this.heartbeat = setInterval(() => {
      const client = this.client;
      if (!client) return;
      for (const nodeId of this.nodes) {
        client.publish(
          mqttTopics.heartbeat(nodeId),
          JSON.stringify({
            schema: 'heartbeat/1',
            node: nodeId,
            ts: this.clock.now().toISOString(),
            controller: this.controllerId,
            epoch: this.epoch,
          }),
          mqttQos.heartbeat,
        );
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private logAlarm(
    nodeId: NodeId,
    code: string,
    severity: string,
    message: string,
  ): void {
    const line = `[${nodeId}] ${code}: ${message}`;
    if (severity === 'critical') this.logger.error(line);
    else if (severity === 'warning') this.logger.warn(line);
    else this.logger.log(line);
  }

  /** A node stuck publishing malformed payloads must not bury everything else. */
  private warnThrottled(key: string, message: string): void {
    const nowMs = this.clock.now().getTime();
    const last = this.warnedAt.get(key);
    if (last !== undefined && nowMs - last < WARN_THROTTLE_MS) {
      this.logger.debug(message);
      return;
    }
    this.warnedAt.set(key, nowMs);
    this.logger.warn(message);
  }

  private requireClient(): MqttClient {
    if (!this.client) {
      // Failing loudly beats queueing a burner command for an unknown future.
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `No MQTT connection (${MQTT_ROOT})`,
      );
    }
    return this.client;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
