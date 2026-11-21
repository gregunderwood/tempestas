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
  MQTT_SCHEMAS,
  mqttQos,
  mqttTopics,
  type GpioLevel,
  type GpioResultPayload,
  type NodeId,
} from '@tempestas/domain';
import { Clock } from '../common/clock';
import { describeError } from '../common/describe-error';
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
  EMPTY_PAYLOAD_REASON,
  buildGpioSet,
  buildGpioSync,
  buildStatus,
  decodeAlarm,
  decodeGpioState,
  decodeHello,
  decodeResult,
  decodeSample,
  decodeStatus,
  isCommandTopicKind,
  isEmptyPayload,
  isGpioLevel,
  parseJson,
  parseNodeTopic,
  readCommandIssuer,
  toGpioLines,
  verifyResult,
  type CommandTopicKind,
  type Decoded,
} from './mqtt-codec';
import { isPinKeyOfNode, toPinKey } from './pin-key';

const COMMAND_TIMEOUT_MS = 5_000;
// Outlives the ack timeout, yet short enough that a queued or replayed command is refused.
const COMMAND_TTL_MS = 15_000;
/** The node's dead-man counts these. Missing them is what makes it fail safe. */
const HEARTBEAT_INTERVAL_MS = 5_000;
const WARN_THROTTLE_MS = 5 * 60 * 1000;
const CONFLICT_ALARM_WINDOW_MS = 10_000;
const RECONNECT_PERIOD_MS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MQTT_URL = 'mqtt://127.0.0.1:1883';
const SUBSCRIBE_OPTIONS = { qos: 1 } as const;
const CLEAR_RETAINED_OPTIONS = { qos: 1, retain: true } as const;
const UNKNOWN_SENSOR_ID = 'unknown';
const UNPARSED_PIN = -1;

interface PendingCommand {
  nodeId: NodeId;
  commands: readonly PinCommand[];
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PinLevel {
  level: GpioLevel | null;
  known: boolean;
}

function unknownPinLevel(): PinLevel {
  return { level: null, known: false };
}

// The only importer of `mqtt`. Its safety properties are in docs/Infrastructure/MQTT Contract.md.
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
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly pinLevels = new Map<string, PinLevel>();
  private readonly lastReports = new Map<string, PinStateReport>();
  private readonly isOnlineByNode = new Map<NodeId, boolean>();
  private readonly knownNodes = new Set<NodeId>();
  private readonly lastActedAt = new Map<string, number>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private commandCount = 0;
  private connectCount = 0;

  private readonly controllerId = `nestjs-${process.pid}`;
  private readonly epoch: number;
  // A follower ingests everything, commands nothing, and neither heartbeats nor registers a will.
  private readonly role: ControllerRole;

  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {
    super();
    this.epoch = this.clock.now().getTime();
    this.role = resolveControllerRole(
      this.config.get<string>('CONTROLLER_ROLE'),
      true,
    );
  }

  get isLeader(): boolean {
    return this.role === 'leader';
  }

  // Not in the constructor: every onModuleInit, the registry's included, must subscribe first.
  onApplicationBootstrap(): void {
    const url = this.config.get<string>('MQTT_URL', DEFAULT_MQTT_URL);
    const options = this.buildClientOptions();
    const client = connect(url, options);
    this.client = client;
    this.attachClientHandlers(client, url, options.clientId);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopHeartbeat();
    this.rejectPendingCommands();

    const client = this.client;
    this.client = null;
    if (!client) return;

    // Explicit, because a graceful disconnect fires no will.
    try {
      await this.publishServerStatus(client, 'offline');
    } catch (error: unknown) {
      this.logger.warn(
        `Could not publish the offline status: ${describeError(error)}`,
      );
    }
    await client.endAsync();
  }

  async setPin(nodeId: NodeId, command: PinCommand): Promise<void> {
    this.refuseIfFollower('set a pin');
    return this.dispatch(nodeId, [command]);
  }

  // No result topic for a sync: it resolves once the broker accepts the publish.
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
  pinState(nodeId: NodeId, pin: number): PinLevel {
    return this.pinLevels.get(toPinKey(nodeId, pin)) ?? unknownPinLevel();
  }

  lastPinReport(nodeId: NodeId, pin: number): PinStateReport | null {
    return this.lastReports.get(toPinKey(nodeId, pin)) ?? null;
  }

  private buildClientOptions(): IClientOptions & { clientId: string } {
    const username = this.config.get<string>('MQTT_USERNAME', '');
    const password = this.config.get<string>('MQTT_PASSWORD', '');
    return {
      clientId: `tempestas-server-${process.pid}`,
      // A persistent session is a queue of commands waiting to replay on reconnect.
      clean: true,
      // Ours is the only subscribe, so its acknowledgement is a real SUBACK, not a library shortcut.
      resubscribe: false,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      // Leader only: a follower crashing must not tell every node to fail safe.
      ...(this.isLeader ? { will: this.buildServerWill() } : {}),
    };
  }

  private buildServerWill(): IClientOptions['will'] {
    return {
      topic: mqttTopics.serverStatus,
      payload: Buffer.from(
        JSON.stringify(buildStatus('server', 'offline', this.clock.now())),
      ),
      qos: mqttQos.serverStatus.qos,
      retain: mqttQos.serverStatus.retain,
    };
  }

  private attachClientHandlers(
    client: MqttClient,
    url: string,
    clientId: string,
  ): void {
    client.on('connect', () => {
      this.logger.log(`Connected to ${url} as ${clientId}`);
      void this.subscribeThenAnnounceOnline(client);
      this.startHeartbeat();
    });
    client.on('message', (topic, payload, packet) => {
      this.route(topic, payload, packet.retain === true);
    });
    client.on('error', (error) =>
      this.logger.error(`MQTT error: ${error.message}`),
    );
    client.on('reconnect', () =>
      this.logger.warn('Reconnecting to the broker'),
    );
    client.on('close', () => this.logger.warn('Broker connection closed'));
  }

  // Every node answers `online` with a hello, which is not retained and is lost without the SUBACK.
  private async subscribeThenAnnounceOnline(client: MqttClient): Promise<void> {
    const connectNumber = ++this.connectCount;
    await this.subscribeToAllNodes(client);
    // Queued while disconnected, it would replay ahead of the next connect's subscribe.
    if (!this.isStillConnectedAs(client, connectNumber)) return;
    // Even after a refused subscribe: the server is connected and heartbeating, and a retained `offline` says not.
    await this.announceServerOnline();
  }

  private isStillConnectedAs(
    client: MqttClient,
    connectNumber: number,
  ): boolean {
    return client.connected && connectNumber === this.connectCount;
  }

  private async subscribeToAllNodes(client: MqttClient): Promise<void> {
    try {
      await client.subscribeAsync(mqttTopics.allNodes, SUBSCRIBE_OPTIONS);
      this.logger.log(`Subscribed to ${mqttTopics.allNodes}`);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to subscribe to ${mqttTopics.allNodes}, so no hello or reading will arrive: ${describeError(error)}`,
      );
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private rejectPendingCommands(): void {
    for (const [id, command] of this.pendingCommands) {
      clearTimeout(command.timer);
      command.reject(new Error('Server is shutting down'));
      this.pendingCommands.delete(id);
    }
  }

  // Refused locally, so a click on a follower's UI cannot manufacture a CONTROLLER_CONFLICT alarm.
  private refuseIfFollower(action: string): void {
    if (this.isLeader) return;
    throw new HardwareError(
      ApiErrorCode.ControllerIsFollower,
      `This server is a follower and cannot ${action}. Promote it first.`,
    );
  }

  private async dispatch(
    nodeId: NodeId,
    commands: readonly PinCommand[],
  ): Promise<void> {
    const client = this.requireClient();
    this.refuseIfKnownOffline(nodeId);

    const id = `${this.controllerId}-${++this.commandCount}`;
    const payload = buildGpioSet(
      { nodeId, now: this.clock.now() },
      id,
      this.controllerId,
      toGpioLines(commands),
      COMMAND_TTL_MS,
    );

    // Registered before the publish: a fast node can answer before `publishAsync` resolves.
    const acknowledgement = this.awaitAcknowledgement(id, nodeId, commands);

    try {
      await client.publishAsync(
        mqttTopics.gpioSet(nodeId),
        JSON.stringify(payload),
        mqttQos.gpioSet,
      );
    } catch (error: unknown) {
      this.abandonPendingCommand(id);
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `Could not publish to "${nodeId}": ${describeError(error)}`,
      );
    }
    return acknowledgement;
  }

  // Only a positive offline: a node not yet heard from is left to the ack timeout.
  private refuseIfKnownOffline(nodeId: NodeId): void {
    if (this.isOnlineByNode.get(nodeId) !== false) return;
    throw new HardwareError(
      ApiErrorCode.NodeOffline,
      `Node "${nodeId}" is offline; its last will has fired`,
    );
  }

  private awaitAcknowledgement(
    id: string,
    nodeId: NodeId,
    commands: readonly PinCommand[],
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(
          new HardwareError(
            ApiErrorCode.HardwareUnreachable,
            `Node "${nodeId}" did not acknowledge command ${id} within ${COMMAND_TIMEOUT_MS}ms`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      this.pendingCommands.set(id, {
        nodeId,
        commands,
        resolve,
        reject,
        timer,
      });
    });
  }

  private abandonPendingCommand(id: string): void {
    const pending = this.pendingCommands.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(id);
  }

  private route(topic: string, payload: Buffer, isRetained: boolean): void {
    const parsed = parseNodeTopic(topic);
    if (!parsed) return;

    if (isCommandTopicKind(parsed.kind)) {
      this.inspectCommand(
        topic,
        parsed.nodeId,
        parsed.kind,
        payload,
        isRetained,
      );
      return;
    }
    if (parsed.kind === 'heartbeat' || parsed.kind === 'unknown') {
      return;
    }

    const json = parseJson(payload);
    // `=== false`, not `!`: only the literal comparison narrows these unions under this config.
    if (json.ok === false) {
      const isRetainedClear =
        isRetained && json.reason === EMPTY_PAYLOAD_REASON;
      if (!isRetainedClear) {
        this.warnThrottled(
          `${parsed.nodeId}:${parsed.kind}:json`,
          `${topic}: ${json.reason}`,
        );
      }
      return;
    }

    const now = this.clock.now();
    const nodeId = parsed.nodeId;
    this.knownNodes.add(nodeId);

    switch (parsed.kind) {
      case 'hello':
        return this.receiveHello(nodeId, json.value, now);
      case 'status':
        return this.receiveStatus(nodeId, json.value, now);
      case 'sample':
        return this.receiveSample(
          nodeId,
          parsed.sensorId ?? UNKNOWN_SENSOR_ID,
          json.value,
          now,
        );
      case 'gpio-state':
        return this.receiveGpioState(
          nodeId,
          parsed.pin ?? UNPARSED_PIN,
          json.value,
          isRetained,
        );
      case 'gpio-result':
        return this.receiveResult(nodeId, json.value);
      case 'alarm':
        return this.receiveAlarm(nodeId, json.value);
    }
  }

  private receiveHello(
    nodeId: NodeId,
    raw: Record<string, unknown>,
    now: Date,
  ): void {
    const hello = this.unwrapOrWarn(
      decodeHello(raw, nodeId, now),
      `${nodeId}:hello`,
      `Rejected hello from "${nodeId}"`,
    );
    if (hello) this.hello.next(hello);
  }

  private receiveStatus(
    nodeId: NodeId,
    raw: Record<string, unknown>,
    now: Date,
  ): void {
    const availability = this.unwrapOrWarn(
      decodeStatus(raw, nodeId, now),
      `${nodeId}:status`,
      `Rejected status from "${nodeId}"`,
    );
    if (!availability) return;
    this.isOnlineByNode.set(nodeId, availability.online);
    // Stale is not off: a dropped node's pins become unknown.
    if (!availability.online) this.forgetPins(nodeId);
    this.availability.next(availability);
  }

  private receiveSample(
    nodeId: NodeId,
    sensorId: string,
    raw: Record<string, unknown>,
    now: Date,
  ): void {
    const sample = this.unwrapOrWarn(
      decodeSample(raw, nodeId, sensorId, now),
      `${nodeId}:sample`,
      `Dropped sample from "${nodeId}"`,
    );
    if (sample) this.samples.next(sample);
  }

  private receiveGpioState(
    nodeId: NodeId,
    pin: number,
    raw: Record<string, unknown>,
    isRetained: boolean,
  ): void {
    const state = this.unwrapOrWarn(
      decodeGpioState(raw, pin),
      `${nodeId}:state`,
      `Rejected gpio/state from "${nodeId}"`,
    );
    if (!state) return;
    const pinKey = toPinKey(nodeId, state.pin);
    this.pinLevels.set(pinKey, { level: state.level, known: state.known });
    const report: PinStateReport = {
      nodeId,
      pin: state.pin,
      level: state.level,
      known: state.known,
      observedAt: state.observedAt,
      live: !isRetained,
    };
    this.lastReports.set(pinKey, report);
    this.pinStates.next(report);
  }

  private receiveResult(nodeId: NodeId, raw: Record<string, unknown>): void {
    const result = this.unwrapOrWarn(
      decodeResult(raw),
      `${nodeId}:result`,
      `Rejected gpio/result from "${nodeId}"`,
    );
    if (result) this.settle(nodeId, result);
  }

  private receiveAlarm(nodeId: NodeId, raw: Record<string, unknown>): void {
    const alarm = this.unwrapOrWarn(
      decodeAlarm(raw),
      `${nodeId}:alarm`,
      `Rejected alarm from "${nodeId}"`,
    );
    if (alarm) {
      this.logAlarm(nodeId, alarm.code, alarm.severity, alarm.message);
    }
  }

  private unwrapOrWarn<T>(
    decoded: Decoded<T>,
    warnKey: string,
    rejection: string,
  ): T | undefined {
    if (decoded.ok === false) {
      this.warnThrottled(warnKey, `${rejection}: ${decoded.reason}`);
      return undefined;
    }
    return decoded.value;
  }

  private settle(nodeId: NodeId, result: GpioResultPayload): void {
    const command = this.pendingCommands.get(result.id);
    if (!command) {
      // Timed out already, or issued by another controller: worth knowing, not acting on.
      this.logger.debug(`Unmatched gpio/result ${result.id} from "${nodeId}"`);
      return;
    }
    clearTimeout(command.timer);
    this.pendingCommands.delete(result.id);

    for (const line of result.lines) {
      this.pinLevels.set(toPinKey(nodeId, line.pin), {
        level: line.readback,
        known: isGpioLevel(line.readback),
      });
    }

    const mismatch = verifyResult(result, command.commands);
    if (mismatch) {
      this.logAlarm(
        nodeId,
        AlarmCode.ReadbackMismatch,
        'critical',
        mismatch.reason,
      );
      command.reject(
        new HardwareError(ApiErrorCode.ReadbackMismatch, mismatch.reason),
      );
      return;
    }
    command.resolve();
  }

  // Judged by ownership, never the retain flag: see the retained-command trap in docs.
  private inspectCommand(
    topic: string,
    nodeId: NodeId,
    kind: CommandTopicKind,
    payload: Buffer,
    isRetained: boolean,
  ): void {
    // Reacting to the clear itself would become a publish loop against ourselves.
    if (isEmptyPayload(payload)) {
      return;
    }

    const json = parseJson(payload);
    if (json.ok === false) {
      if (isRetained) {
        this.clearRetainedCommand(topic, nodeId, `unparseable ${kind}`);
      }
      return;
    }

    const issuer = readCommandIssuer(kind, json.value);
    if (issuer === this.controllerId) return;

    if (!this.isFirstInWindow(`conflict:${topic}`, CONFLICT_ALARM_WINDOW_MS)) {
      return;
    }
    this.logAlarm(
      nodeId,
      AlarmCode.ControllerConflict,
      'critical',
      `Foreign ${kind} on ${topic} issued by "${String(issuer)}"` +
        `${isRetained ? ' (delivered RETAINED)' : ''} - this server is the only legitimate publisher`,
    );
    this.clearRetainedCommand(topic, nodeId, kind);
  }

  private clearRetainedCommand(
    topic: string,
    nodeId: NodeId,
    description: string,
  ): void {
    this.client?.publish(topic, '', CLEAR_RETAINED_OPTIONS, (error) => {
      if (error) {
        this.logger.error(
          `Failed to clear the retained ${description} on ${topic}: ${error.message}`,
        );
        return;
      }
      this.logger.warn(
        `Cleared the retained slot on ${topic} (${description}, node "${nodeId}")`,
      );
    });
  }

  private isFirstInWindow(key: string, windowMs: number): boolean {
    const nowMs = this.clock.now().getTime();
    const last = this.lastActedAt.get(key);
    if (last !== undefined && nowMs - last < windowMs) return false;
    this.lastActedAt.set(key, nowMs);
    return true;
  }

  private forgetPins(nodeId: NodeId): void {
    for (const pinKey of this.pinLevels.keys()) {
      if (isPinKeyOfNode(pinKey, nodeId)) {
        this.pinLevels.set(pinKey, unknownPinLevel());
      }
    }
    // A relay may have failed safe since, so seeding a new device from it would be a guess.
    for (const pinKey of this.lastReports.keys()) {
      if (isPinKeyOfNode(pinKey, nodeId)) this.lastReports.delete(pinKey);
    }
  }

  private async announceServerOnline(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await this.publishServerStatus(client, 'online');
    } catch (error: unknown) {
      this.logger.warn(
        `Could not announce the server as online: ${describeError(error)}`,
      );
    }
  }

  private publishServerStatus(
    client: MqttClient,
    state: 'online' | 'offline',
  ): Promise<unknown> {
    return client.publishAsync(
      mqttTopics.serverStatus,
      JSON.stringify(buildStatus('server', state, this.clock.now())),
      mqttQos.serverStatus,
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    if (!this.isLeader) {
      // A heartbeat grants the right to command; from a follower, nodes would obey two controllers.
      this.logger.log(
        'Follower: not heartbeating, so no node will bind to this server',
      );
      return;
    }
    this.heartbeatTimer = setInterval(
      () => this.publishHeartbeats(),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  private publishHeartbeats(): void {
    const client = this.client;
    if (!client) return;
    for (const nodeId of this.knownNodes) {
      client.publish(
        mqttTopics.heartbeat(nodeId),
        JSON.stringify({
          schema: MQTT_SCHEMAS.heartbeat,
          node: nodeId,
          ts: this.clock.now().toISOString(),
          controller: this.controllerId,
          epoch: this.epoch,
        }),
        mqttQos.heartbeat,
      );
    }
  }

  private logAlarm(
    nodeId: NodeId,
    code: string,
    severity: string,
    message: string,
  ): void {
    const line = `[${nodeId}] ${code}: ${message}`;
    if (severity === 'critical') {
      this.logger.error(line);
      return;
    }
    if (severity === 'warning') {
      this.logger.warn(line);
      return;
    }
    this.logger.log(line);
  }

  private warnThrottled(key: string, message: string): void {
    if (this.isFirstInWindow(key, WARN_THROTTLE_MS)) {
      this.logger.warn(message);
      return;
    }
    this.logger.debug(message);
  }

  private requireClient(): MqttClient {
    if (!this.client) {
      // Never queue a burner command for an unknown future.
      throw new HardwareError(
        ApiErrorCode.HardwareUnreachable,
        `No MQTT connection (${MQTT_ROOT})`,
      );
    }
    return this.client;
  }
}
