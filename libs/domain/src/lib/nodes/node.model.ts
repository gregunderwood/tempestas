/**
 * A node is a wiring and transport identity: which box owns this pin, which box
 * holds this sensor. It is deliberately NOT the unit that rules scope to - see
 * `zones/zone.model.ts` for why.
 *
 * The uniformity invariant: nothing outside this file may branch on `NodeKind`.
 * The server asks only "does this node expose pin N?" and "which metrics does
 * this sensor publish?" - both answered by `NodeCapabilities`. That is what makes
 * adding a Raspberry Pi, or an ESP32, a matter of data rather than code.
 */

/** The node's slug. Immutable after admission - it is the MQTT topic segment. */
export type NodeId = string;

export enum NodeKind {
  RaspberryPi = 'rpi',
  Esp32 = 'esp32',
  /** A stand-in for something that speaks no MQTT, e.g. the legacy Flask system. */
  Virtual = 'virtual',
}

export enum NodeStatus {
  /** Announced itself but not yet admitted: receives no commands, readings discarded. */
  Pending = 'pending',
  Admitted = 'admitted',
  Disabled = 'disabled',
}

export type MetricKey = 'temperature' | 'humidity' | 'co2';

export interface GpioCapability {
  /** The pins this node is willing to expose. Devices may only claim pins in here. */
  pins: number[];
  supportsReadback: boolean;
}

export interface SensorCapability {
  sensorId: string;
  /** Free-form, for display only. Never branched on. e.g. 'scd4x', 'ds18b20'. */
  kind: string;
  metrics: MetricKey[];
  sampleIntervalMs: number;
}

export interface NodeCapabilities {
  contractVersion: 1;
  /** Absent means a sensor-only node. */
  gpio?: GpioCapability;
  /** Empty means an actuator-only node. */
  sensors: SensorCapability[];
  /** An ESP32 handles commands more slowly than a Pi. */
  maxCommandRateHz?: number;
  /** An ESP32 has no RTC, so its timestamps are diagnostic only. */
  hasRtc: boolean;
}

export interface Node {
  id: string;
  slug: NodeId;
  displayName: string;
  location: string | null;
  kind: NodeKind;
  status: NodeStatus;
  online: boolean;
  lastSeenAt: string | null;
  agentVersion: string | null;
  capabilities: NodeCapabilities;
  zoneId: string | null;
  deviceCount: number;
  latestReadingAt: string | null;
}

/**
 * Admission is the safety gate, not a convenience. A stray ESP32 on the WiFi
 * must not be able to inject a temperature reading that starts a combustion
 * burner, so an unknown node lands as `pending` and a human promotes it.
 *
 * `slug` is absent deliberately: it is the MQTT topic segment and the ACL
 * subject, so renaming it would orphan the node's whole topic subtree.
 */
export interface AdmitNodePayload {
  /** The airspace this node's readings and relays belong to. */
  zoneId?: string;
  displayName?: string;
  location?: string | null;
}

/** The human-owned fields. Everything else about a node comes from its `hello`. */
export interface UpdateNodePayload {
  zoneId?: string;
  displayName?: string;
  location?: string | null;
}
