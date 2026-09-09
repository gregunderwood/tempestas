import type { Observable } from 'rxjs';
import type {
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

export interface PinCommand {
  pin: number;
  level: GpioLevel;
  label?: string;
}

export abstract class HardwareService {
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
}
