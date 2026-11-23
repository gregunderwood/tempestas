import type { Device, DeviceRole } from '../devices/device.model';
import type { Node } from '../nodes/node.model';
import type { Reading } from '../readings/reading.model';
import type { RulesCycle } from '../rules/rules.model';

export const REALTIME_EVENTS = {
  readingLatest: 'reading:latest',
  deviceState: 'device:state',
  systemStatus: 'system:status',
  rulesCycle: 'rules:cycle',
  nodeState: 'node:state',
} as const;

export type RealtimeEvent =
  (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

/** Feeds the stale banner, which the safety design relies on a human noticing. */
export interface SystemStatus {
  at: string;
  sensorStale: boolean;
  staleRoles: DeviceRole[];
  nodesOnline: number;
  nodesTotal: number;
  /** Announced, waiting for a human to admit them. */
  nodesPending: number;
  /** False on a follower, which runs no rules and switches nothing. */
  isLeading: boolean;
  lastEvaluationAt: string | null;
  /** Server clock as this copy left, replay included, so a browser can measure its own skew. */
  sentAt: string;
}

export type UnsentSystemStatus = Omit<SystemStatus, 'sentAt'>;

export interface RealtimePayloads {
  [REALTIME_EVENTS.readingLatest]: Reading;
  [REALTIME_EVENTS.deviceState]: Device;
  [REALTIME_EVENTS.systemStatus]: SystemStatus;
  [REALTIME_EVENTS.rulesCycle]: RulesCycle;
  [REALTIME_EVENTS.nodeState]: Node;
}
