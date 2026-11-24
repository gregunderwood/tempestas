import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';

export const ZONE_HISTORY_HOURS = 24;
/** Buckets start on whole multiples of this since the Unix epoch, so a client can bucket a pushed reading the same way. */
export const ZONE_HISTORY_BUCKET_MINUTES = 5;

/** `unknown` is neither on nor off: no history, `energised = null`, or the node was offline. */
export type RelayState = 'on' | 'off' | 'unknown';

export interface TemperatureBucket {
  at: string;
  averageC: number;
  lowestC: number;
  highestC: number;
  sampleCount: number;
}

export interface ProbeHistory {
  nodeId: NodeId;
  sensorId: string;
  /** Oldest first; a bucket with no readings is absent, not zero. */
  buckets: TemperatureBucket[];
}

export interface RelaySpan {
  state: RelayState;
  from: string;
  to: string;
}

export interface DeviceRunHistory {
  deviceId: string;
  deviceName: string;
  role: DeviceRole | null;
  nodeId: NodeId;
  /** Oldest first and contiguous, from the later of the window's start and the device being added, to `to`. */
  spans: RelaySpan[];
}

export interface ZoneHistory {
  zoneId: string;
  probes: ProbeHistory[];
  devices: DeviceRunHistory[];
}

export interface ZoneHistoryReport {
  from: string;
  /** When it was generated; the last span of each device runs on past it until something changes. */
  to: string;
  zones: ZoneHistory[];
}
