import type {
  AgentVersionChange,
  NodeHealth,
  NodeId,
  NodeReboot,
  ReadingGap,
} from '@tempestas/domain';
import { MILLISECONDS_PER_MINUTE } from '../common/time-units';
import type { NodeReadingSpan, ReadingBreak } from '../readings/reading-breaks';

export interface HealthNode {
  nodeId: NodeId;
  nodeName: string;
  timezone: string;
  hasSensors: boolean;
}

export interface NodeVersionChange extends AgentVersionChange {
  nodeId: NodeId;
}

export interface NodeHealthHistory {
  nodes: readonly HealthNode[];
  breaks: readonly ReadingBreak[];
  readingSpans: readonly NodeReadingSpan[];
  versionChanges: readonly NodeVersionChange[];
  gapMinutes: number;
  now: Date;
}

export function summariseNodeHealth(history: NodeHealthHistory): NodeHealth[] {
  return history.nodes.map((node) => summariseNode(node, history));
}

function summariseNode(
  node: HealthNode,
  history: NodeHealthHistory,
): NodeHealth {
  const breaks = history.breaks.filter(
    (readingBreak) => readingBreak.nodeId === node.nodeId,
  );
  const readingSpan = history.readingSpans.find(
    (span) => span.nodeId === node.nodeId,
  );
  return {
    ...node,
    firstReadingAt: readingSpan?.firstAt.toISOString() ?? null,
    gaps: listGaps(breaks, readingSpan, history).reverse(),
    reboots: listReboots(breaks).reverse(),
    versionChanges: listVersionChanges(node, history.versionChanges),
  };
}

function listGaps(
  breaks: readonly ReadingBreak[],
  readingSpan: NodeReadingSpan | undefined,
  history: NodeHealthHistory,
): ReadingGap[] {
  const closedGaps = breaks
    .filter((readingBreak) => readingBreak.isGap)
    .map((readingBreak) =>
      toGap(readingBreak.previousAt, readingBreak.at, false),
    );
  const ongoingGap = findOngoingGap(readingSpan, history);
  return ongoingGap ? [...closedGaps, ongoingGap] : closedGaps;
}

function findOngoingGap(
  readingSpan: NodeReadingSpan | undefined,
  history: NodeHealthHistory,
): ReadingGap | null {
  if (!readingSpan) return null;
  const silentMinutes = countMinutesBetween(readingSpan.lastAt, history.now);
  if (silentMinutes <= history.gapMinutes) return null;
  return toGap(readingSpan.lastAt, history.now, true);
}

function listReboots(breaks: readonly ReadingBreak[]): NodeReboot[] {
  return breaks
    .filter((readingBreak) => readingBreak.isNewBoot)
    .map((readingBreak) => ({ at: readingBreak.at.toISOString() }));
}

function listVersionChanges(
  node: HealthNode,
  versionChanges: readonly NodeVersionChange[],
): AgentVersionChange[] {
  return versionChanges
    .filter((change) => change.nodeId === node.nodeId)
    .map(({ fromVersion, toVersion, isRollBack, at }) => ({
      fromVersion,
      toVersion,
      isRollBack,
      at,
    }))
    .sort((first, second) => second.at.localeCompare(first.at));
}

function toGap(from: Date, to: Date, isOngoing: boolean): ReadingGap {
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minutes: Math.round(countMinutesBetween(from, to)),
    isOngoing,
  };
}

function countMinutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MILLISECONDS_PER_MINUTE;
}
