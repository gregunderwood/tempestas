/** The node's slug. Immutable after admission: it is the MQTT topic segment. */
export type NodeId = string;

/** Nothing outside this file may branch on it; ask `NodeCapabilities` instead. */
export enum NodeKind {
  RaspberryPi = 'rpi',
  Esp32 = 'esp32',
  PicoW = 'pico',
  /** A stand-in for something that speaks no MQTT, e.g. the legacy Flask system. */
  Virtual = 'virtual',
}

export enum NodeStatus {
  /** Receives no commands, and its readings are discarded. */
  Pending = 'pending',
  Admitted = 'admitted',
  Disabled = 'disabled',
}

export type MetricKey = 'temperature' | 'humidity' | 'co2';

export interface GpioCapability {
  /** Devices may only claim pins in here. */
  pins: number[];
  supportsReadback: boolean;
}

export interface SensorCapability {
  sensorId: string;
  /** For display only, never branched on, e.g. 'scd4x'. */
  kind: string;
  metrics: MetricKey[];
  sampleIntervalMs: number;
}

export interface NodeCapabilities {
  contractVersion: 1;
  /** Absent means 0. A different minor still works; only the additions go unused. */
  contractMinor?: number;
  /** Absent on a sensor-only node. */
  gpio?: GpioCapability;
  /** Empty on an actuator-only node. */
  sensors: SensorCapability[];
  maxCommandRateHz?: number;
  /** Without one, the node's timestamps are diagnostic only. */
  hasRtc: boolean;
}

/** How a node's contract minor compares with the server's. Any of them works; see the MQTT contract. */
export type ContractStanding = 'current' | 'behind' | 'ahead';

/** `agent-linux 1.0.3`, or just the version from an agent that predates naming itself. */
export function describeAgent(agent: {
  agentName: string | null;
  agentVersion: string | null;
}): string {
  return [agent.agentName, agent.agentVersion ?? 'unknown']
    .filter(Boolean)
    .join(' ');
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
  agentName: string | null;
  agentVersion: string | null;
  contractStanding: ContractStanding;
  /** The newest released version this node could be updated to from the web, or null. */
  availableUpdate: string | null;
  capabilities: NodeCapabilities;
  zoneId: string | null;
  deviceCount: number;
  latestReadingAt: string | null;
}

/** The human-owned fields. `slug` is absent: renaming it would orphan the node's topics. */
interface HumanOwnedNodeFields {
  zoneId?: string;
  displayName?: string;
  location?: string | null;
}

export type AdmitNodePayload = HumanOwnedNodeFields;

export type UpdateNodePayload = HumanOwnedNodeFields;
