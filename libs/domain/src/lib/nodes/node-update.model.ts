import type { UpdateState } from '../hardware/mqtt-contract';

/** How an update started from the web ended, or that it has not yet. */
export enum NodeUpdateOutcome {
  InProgress = 'in-progress',
  Healthy = 'healthy',
  RolledBack = 'rolled-back',
  Failed = 'failed',
  /** The server stopped waiting. A final state the node sends later still replaces it. */
  TimedOut = 'timed-out',
}

/** One update the server sent a node, keyed by the command's id. */
export interface NodeUpdate {
  id: string;
  fromVersion: string | null;
  toVersion: string;
  isRollBack: boolean;
  lastState: UpdateState | null;
  outcome: NodeUpdateOutcome;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What the node page needs to offer an update or a roll back, and to show the last one. */
export interface NodeUpdateSummary {
  /** Why this node's agent never takes an update from the web, so "up to date" would mislead. */
  notUpdatableBecause: string | null;
  /** Why neither button may be pressed right now, or null when they may. */
  blockedBecause: string | null;
  /** The version the node ran before its last healthy update, while that bundle is still offered. */
  rollBackVersion: string | null;
  lastUpdate: NodeUpdate | null;
}

export const NO_UPDATE_SUMMARY: NodeUpdateSummary = {
  notUpdatableBecause: null,
  blockedBecause: null,
  rollBackVersion: null,
  lastUpdate: null,
};

/** The version the operator confirmed, so the server never sends one they did not see. */
export interface NodeUpdateRequest {
  version: string;
}

export function isUpdateInProgress(update: NodeUpdate | null): boolean {
  return update?.outcome === NodeUpdateOutcome.InProgress;
}
