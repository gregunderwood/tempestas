import type { Reading, RulesCycle, SystemStatus } from '@tempestas/domain';
import { READING_QUIET_AFTER_SECONDS } from '../../shared/freshness';
import { secondsSince } from '../../shared/time';
import {
  chooseDecisionTone,
  describeReason,
  formatDuration,
  labelRole,
} from '../zones/zone-words';

export interface AttentionItem {
  key: string;
  text: string;
  link: string | null;
}

export interface AttentionFacts {
  isConnected: boolean;
  status: SystemStatus | null;
  cycle: RulesCycle | null;
  readings: readonly Reading[];
  now: number;
}

export function listAttentionItems(facts: AttentionFacts): AttentionItem[] {
  return [
    ...listConnectionProblems(facts),
    ...listLeadershipProblems(facts.status),
    ...listWaitingNodes(facts.status),
    ...listQuietProbes(facts.readings, facts.now),
    ...listFailingZones(facts.cycle),
    ...listWarningDecisions(facts.cycle),
  ];
}

function listConnectionProblems(facts: AttentionFacts): AttentionItem[] {
  if (facts.isConnected) return [];
  return [
    {
      key: 'offline',
      text: 'Not connected to the server, so nothing here is updating.',
      link: null,
    },
  ];
}

function listLeadershipProblems(status: SystemStatus | null): AttentionItem[] {
  if (status?.isLeading !== false) return [];
  return [
    {
      key: 'follower',
      text: 'This server is a follower: it runs no rules and switches nothing.',
      link: null,
    },
  ];
}

function listWaitingNodes(status: SystemStatus | null): AttentionItem[] {
  const waiting = status?.nodesPending ?? 0;
  if (waiting === 0) return [];
  const nodes = waiting === 1 ? '1 node is' : `${waiting} nodes are`;
  return [
    {
      key: 'pending',
      text: `${nodes} waiting to be admitted.`,
      link: '/nodes',
    },
  ];
}

function listQuietProbes(
  readings: readonly Reading[],
  now: number,
): AttentionItem[] {
  return readings
    .map((reading) => ({
      reading,
      ageSeconds: secondsSince(reading.createdAt, now),
    }))
    .filter((probe) => probe.ageSeconds > READING_QUIET_AFTER_SECONDS)
    .map((probe) => ({
      key: `quiet/${probe.reading.nodeId}/${probe.reading.sensorId}`,
      text: `${probe.reading.nodeId} ${probe.reading.sensorId}: no reading for ${formatDuration(probe.ageSeconds)}.`,
      link: `/nodes/${probe.reading.nodeId}`,
    }));
}

function listFailingZones(cycle: RulesCycle | null): AttentionItem[] {
  return (cycle?.failingZones ?? []).map((failure) => ({
    key: `failing/${failure.zoneSlug}`,
    text: `${failure.zoneSlug}: rules failed, ${failure.reason}.`,
    link: '/zones',
  }));
}

function listWarningDecisions(cycle: RulesCycle | null): AttentionItem[] {
  return (cycle?.evaluations ?? []).flatMap((evaluation) =>
    evaluation.decisions
      .filter((decision) => chooseDecisionTone(decision) === 'warn')
      .map((decision) => ({
        key: `warn/${evaluation.zoneSlug}/${decision.role}`,
        text: `${evaluation.zoneSlug} ${labelRole(decision.role)}: ${describeReason(decision.reason)}.`,
        link: '/zones',
      })),
  );
}
