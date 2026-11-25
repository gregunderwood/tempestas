import type { Observable } from 'rxjs';
import type {
  AgentApp,
  ApiErrorCode,
  GpioLevel,
  NodeCapabilities,
  NodeId,
  NodeKind,
  UpdateState,
} from '@tempestas/domain';

// Keeps drivers free of HTTP; `translateHardwareError` maps the code to a status, never a bare 500.
export class HardwareError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HardwareError';
  }
}

export interface SensorSample {
  nodeId: NodeId;
  sensorId: string;
  /** Server-stamped on receipt; a node's own clock is diagnostic only. */
  receivedAt: Date;
  temperature: number;
  /** Null when the sensor has none: a DS18B20 measures temperature only. */
  humidity: number | null;
  /** Null means unknown, never zero: a node never substitutes a last-known-good value. */
  co2: number | null;
  nodeSeq: number | null;
}

/** A node announcing itself. Unknown slugs land in the registry as `pending`. */
export interface NodeHello {
  nodeId: NodeId;
  kind: NodeKind;
  /** Null from agents that predate contract 1.0's agent name. */
  agentName: string | null;
  agentVersion: string;
  capabilities: NodeCapabilities;
  /** Changes on every node restart, so a bounce is detectable. */
  bootId: string;
  receivedAt: Date;
}

export interface NodeAvailability {
  nodeId: NodeId;
  online: boolean;
  at: Date;
}

export interface PinStateReport {
  nodeId: NodeId;
  pin: number;
  /** `null` with `known: false` means unknown. Unknown is NOT off. */
  level: GpioLevel | null;
  known: boolean;
  /** The node's own timestamp: it becomes `offAt`, so it decides when the cooldown started. */
  observedAt: Date;
  /** Published while we were subscribed, not a retained replay. */
  live: boolean;
}

export interface PinCommand {
  pin: number;
  level: GpioLevel;
  label?: string;
}

export interface UpdateOrder {
  id: string;
  app: AgentApp;
  version: string;
  manifestUrl: string;
  manifestSha256: string;
}

export interface UpdateStatusReport {
  nodeId: NodeId;
  id: string;
  state: UpdateState;
  reason: string | null;
}

// The single seam to physical hardware; see docs/Architecture.md, "The hardware seam".
export abstract class HardwareService {
  /** Whether this server is the one allowed to command. */
  abstract readonly isLeader: boolean;

  /** Resolves only on a matching readback. Callers must not persist a change when it rejects. */
  abstract setPin(nodeId: NodeId, command: PinCommand): Promise<void>;

  /** Re-assert the full desired state of a node's pins. */
  abstract syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void>;

  /** Resolves once the broker has the command. Progress arrives on `updateStatuses$`. */
  abstract sendUpdate(nodeId: NodeId, order: UpdateOrder): Promise<void>;

  /** Called once the hello is stored, so heartbeats name a version only the registry has taken. */
  abstract recordAcceptedHello(hello: NodeHello): void;

  abstract readonly samples$: Observable<SensorSample>;
  abstract readonly availability$: Observable<NodeAvailability>;
  abstract readonly hello$: Observable<NodeHello>;
  abstract readonly updateStatuses$: Observable<UpdateStatusReport>;

  /** Every line-state report, including the dead-man and failsafe changes nobody asked for. */
  abstract readonly pinStates$: Observable<PinStateReport>;

  /** The last report for one pin since the node came online, so a new device starts from it. */
  abstract lastPinReport(nodeId: NodeId, pin: number): PinStateReport | null;
}
