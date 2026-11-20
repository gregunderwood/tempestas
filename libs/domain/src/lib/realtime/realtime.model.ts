import type { Device } from '../devices/device.model';
import type { DeviceRole } from '../devices/device.model';
import type { Reading } from '../readings/reading.model';
import type { RulesCycle } from '../rules/rules.model';

/**
 * The socket.io contract to the browser.
 *
 * Named events on one socket, rather than the old system's bare `rxjs/webSocket`
 * feed with no envelope and no reconnect. A Pi on home WiFi needs both.
 */
export const REALTIME_EVENTS = {
  readingLatest: 'reading:latest',
  deviceState: 'device:state',
  systemStatus: 'system:status',
  rulesCycle: 'rules:cycle',
} as const;

export type RealtimeEvent =
  (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

/**
 * What the dashboard needs to raise the banner that makes "hold last state" a
 * sound policy. Layer 1 of the safety design depends on a human noticing, so
 * this is a required part of the feature rather than telemetry.
 */
export interface SystemStatus {
  /** ISO-8601. */
  at: string;
  /** True when any owned role's sensors have gone quiet. Drives the banner. */
  sensorStale: boolean;
  staleRoles: DeviceRole[];
  nodesOnline: number;
  nodesTotal: number;
  /** ISO-8601, or null before the first evaluation. */
  lastEvaluationAt: string | null;
}

/** The payload of each event, so the client cannot mis-type a handler. */
export interface RealtimePayloads {
  'reading:latest': Reading;
  'device:state': Device;
  'system:status': SystemStatus;
  'rules:cycle': RulesCycle;
}
