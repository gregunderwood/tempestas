import type { NodeId } from '../nodes/node.model';

export const NODE_HEALTH_DEFAULT_DAYS = 30;
export const NODE_HEALTH_MAX_DAYS = 90;
/** A silence longer than this is a gap: several samples missed even at the slowest agent's pace. */
export const NODE_HEALTH_GAP_MINUTES = 5;

export interface NodeHealthQuery {
  /** Days back from now. */
  days?: number;
}

export interface ReadingGap {
  /** The last reading before the silence. */
  from: string;
  /** The first reading after it, or now while the node is still silent. */
  to: string;
  minutes: number;
  isOngoing: boolean;
}

export interface NodeReboot {
  /** The first reading under the new boot id. */
  at: string;
}

/** An update the server ran and the node came back healthy from. */
export interface AgentVersionChange {
  fromVersion: string | null;
  toVersion: string;
  isRollBack: boolean;
  at: string;
}

export interface NodeHealth {
  nodeId: NodeId;
  nodeName: string;
  timezone: string;
  /** False for a node with no sensors, which has no readings to find gaps or reboots in. */
  hasSensors: boolean;
  /** Null when the node sent no reading in the whole period. */
  firstReadingAt: string | null;
  /** Newest first. */
  gaps: ReadingGap[];
  /** Newest first. */
  reboots: NodeReboot[];
  /** Newest first. */
  versionChanges: AgentVersionChange[];
}

export interface NodeHealthReport {
  days: number;
  generatedAt: string;
  /** Admitted nodes only: a pending node's readings are discarded. */
  nodes: NodeHealth[];
}
