import {
  ApiErrorCode,
  NodeStatus,
  NodeUpdateOutcome,
  UpdateState,
  type NodeUpdate,
} from '@tempestas/domain';
import { MILLISECONDS_PER_SECOND } from '../common/time-units';
import type { UpdateStatusReport } from '../hardware/hardware.service';
import type { NodeEntity, NodeUpdateEntity } from './models';

const FINAL_STATE_WAIT_MINUTES = 5;
export const FINAL_STATE_WAIT_MS =
  FINAL_STATE_WAIT_MINUTES * 60 * MILLISECONDS_PER_SECOND;

const OUTCOME_OF_FINAL_STATE: Partial<Record<UpdateState, NodeUpdateOutcome>> =
  {
    [UpdateState.Healthy]: NodeUpdateOutcome.Healthy,
    [UpdateState.RolledBack]: NodeUpdateOutcome.RolledBack,
    [UpdateState.Failed]: NodeUpdateOutcome.Failed,
  };

export interface UpdateRefusal {
  code: ApiErrorCode;
  message: string;
}

/** What decides whether a node may be sent an update right now. */
export interface UpdateConditions {
  isReleasesUrlSet: boolean;
  isLeader: boolean;
  /** The one update any node is still running, with the slug of that node. */
  updateInProgress: { nodeSlug: string } | null;
}

// Checked for the button as well as the request, so the page says why before anyone presses it.
export function findUpdateRefusal(
  node: NodeEntity,
  conditions: UpdateConditions,
): UpdateRefusal | null {
  if (!conditions.isReleasesUrlSet) {
    return {
      code: ApiErrorCode.UpdatesNotConfigured,
      message:
        'Set AGENT_RELEASES_URL on the server, so nodes know where to download releases.',
    };
  }
  if (!conditions.isLeader) {
    return {
      code: ApiErrorCode.ControllerIsFollower,
      message: 'This server is a follower. Update nodes from the leader.',
    };
  }
  if (node.status !== NodeStatus.Admitted) {
    return {
      code: ApiErrorCode.NodeNotAdmitted,
      message: `"${node.slug}" is ${node.status}. Only an admitted node is updated.`,
    };
  }
  if (!node.online) {
    return {
      code: ApiErrorCode.NodeOffline,
      message: `"${node.slug}" is offline.`,
    };
  }
  if (conditions.updateInProgress) {
    return {
      code: ApiErrorCode.UpdateInProgress,
      message: `"${conditions.updateInProgress.nodeSlug}" is updating. One node at a time.`,
    };
  }
  return null;
}

// Only straight after a healthy update: a later update or roll back has moved the node on.
export function findRollBackVersion(
  node: NodeEntity,
  lastHealthyUpdate: NodeUpdateEntity | null,
): string | null {
  if (!lastHealthyUpdate || lastHealthyUpdate.isRollBack) return null;
  if (lastHealthyUpdate.toVersion !== node.agentVersion) return null;
  return lastHealthyUpdate.fromVersion;
}

function isWaitingForNode(update: NodeUpdateEntity): boolean {
  return (
    update.outcome === NodeUpdateOutcome.InProgress ||
    update.outcome === NodeUpdateOutcome.TimedOut
  );
}

/** Applies what the node said, and reports whether anything changed. */
export function applyUpdateStatus(
  update: NodeUpdateEntity,
  status: UpdateStatusReport,
  now: Date,
): boolean {
  if (!isWaitingForNode(update)) return false;
  const finalOutcome = OUTCOME_OF_FINAL_STATE[status.state];
  // After a time-out only a final state is news; a late progress report would revive it.
  const isLateProgress =
    !finalOutcome && update.outcome === NodeUpdateOutcome.TimedOut;
  if (isLateProgress) return false;

  update.lastState = status.state;
  update.reason = status.reason;
  if (finalOutcome) {
    update.outcome = finalOutcome;
    update.finishedAt = now;
  }
  return true;
}

export function isStalled(update: NodeUpdateEntity, now: Date): boolean {
  return (
    update.outcome === NodeUpdateOutcome.InProgress &&
    now.getTime() - update.startedAt.getTime() >= FINAL_STATE_WAIT_MS
  );
}

export function timeOut(update: NodeUpdateEntity, now: Date): void {
  update.outcome = NodeUpdateOutcome.TimedOut;
  update.finishedAt = now;
  update.reason = update.lastState
    ? `No final state within ${FINAL_STATE_WAIT_MINUTES} minutes. The last state heard was "${update.lastState}".`
    : `No final state within ${FINAL_STATE_WAIT_MINUTES} minutes, and nothing was heard from the node.`;
}

export function toNodeUpdate(update: NodeUpdateEntity): NodeUpdate {
  return {
    id: update.id,
    fromVersion: update.fromVersion,
    toVersion: update.toVersion,
    isRollBack: update.isRollBack,
    lastState: update.lastState,
    outcome: update.outcome,
    reason: update.reason,
    startedAt: update.startedAt.toISOString(),
    finishedAt: update.finishedAt?.toISOString() ?? null,
  };
}
