import type { Observable } from 'rxjs';
import type {
  ApiErrorCode,
  GpioLevel,
  NodeCapabilities,
  NodeId,
  NodeKind,
} from '@tempestas/domain';

/**
 * The single seam between the application and physical hardware.
 *
 * Nothing outside `app/hardware/` may import `mqtt`. Everything else injects
 * this abstract class, which is why the entire application - rules engine,
 * devices, scheduler, gateway - can be built and tested before any node or
 * sidecar exists, by binding it to the fake driver.
 */

/**
 * A hardware failure with a machine-readable code.
 *
 * The driver stays free of HTTP concerns - it throws this, and `DevicesService`
 * translates it into a status code. Without it an offline node surfaced as a
 * bare 500 "Internal server error", which is precisely the class of response
 * this project exists to stop producing: the client cannot tell "the node is
 * gone" from "the server is broken", and neither can the rules engine.
 */
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
  humidity: number;
  /**
   * Null when the node reported an invalid reading. A node reports validity
   * honestly and never substitutes a last-known-good value, so this really
   * does mean "unknown", not "zero".
   */
  co2: number | null;
  nodeSeq: number | null;
}

/** A node announcing itself. Unknown slugs land in the registry as `pending`. */
export interface NodeHello {
  nodeId: NodeId;
  kind: NodeKind;
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

/**
 * A line's state as the node reports it, unsolicited.
 *
 * `observedAt` is the node's own timestamp, not our receive time, because it is
 * written into a device's `offAt` and so decides when the minimum-off window
 * started. A node that fails safe while the controller is dead reports the real
 * moment the relay opened.
 */
export interface PinStateReport {
  nodeId: NodeId;
  pin: number;
  /** `null` with `known: false` means unknown. Unknown is NOT off. */
  level: GpioLevel | null;
  known: boolean;
  observedAt: Date;
}

export interface PinCommand {
  pin: number;
  level: GpioLevel;
  label?: string;
}

export abstract class HardwareService {
  /**
   * Whether this server is the one allowed to command.
   *
   * On the seam rather than only on the MQTT driver, because the rules engine
   * asks it and must not know which driver is behind it. The fake driver is
   * always the leader: it drives nothing real, so there is nothing to contend.
   */
  abstract readonly isLeader: boolean;

  /**
   * Drive one pin on one node. Resolves only once the node acknowledges with a
   * successful readback; rejects on readback mismatch, timeout, or a node that
   * is offline. Callers MUST NOT persist a state change when this rejects -
   * that was the old system's silent DB/hardware divergence.
   */
  abstract setPin(nodeId: NodeId, command: PinCommand): Promise<void>;

  /** Re-assert the full desired state of a node's pins. */
  abstract syncPins(nodeId: NodeId, commands: PinCommand[]): Promise<void>;

  abstract readonly samples$: Observable<SensorSample>;
  abstract readonly availability$: Observable<NodeAvailability>;
  abstract readonly hello$: Observable<NodeHello>;

  /**
   * Every line-state report a node sends, including ones we did not ask for.
   *
   * A node changes lines on its own when its dead-man trips or when it sees the
   * controller's last will, and it is the only party that knows. Without this
   * the driver held the correct level in memory and nothing consumed it, so a
   * device row stayed wrong until somebody noticed.
   */
  abstract readonly pinStates$: Observable<PinStateReport>;
}
