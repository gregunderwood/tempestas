import { MoreThanOrEqual, type Repository } from 'typeorm';
import type { Node } from '@tempestas/domain';
import type { PinTransitionEntity } from './models';
import type { TransitionReason } from './pin-transition';
import type { NodeSighting, RuntimeTransition } from './relay-spans';

const NODE_OFFLINE_REASON: TransitionReason = 'node-offline';

// The row in force when the window opened too, or its first hours would read as unknown.
export async function findRelayTransitionsSince(
  transitions: Repository<PinTransitionEntity>,
  since: Date,
): Promise<RuntimeTransition[]> {
  const [inForceAtStart, inWindow] = await Promise.all([
    transitions
      .createQueryBuilder('pinTransition')
      .distinctOn(['pinTransition.nodeId', 'pinTransition.pin'])
      .where('pinTransition.observedAt < :since', { since })
      .orderBy('pinTransition.nodeId')
      .addOrderBy('pinTransition.pin')
      .addOrderBy('pinTransition.observedAt', 'DESC')
      .getMany(),
    transitions.find({ where: { observedAt: MoreThanOrEqual(since) } }),
  ]);
  return [...inForceAtStart, ...inWindow].map(toRuntimeTransition);
}

export function mapSightingsByNode(
  nodes: readonly Node[],
): Map<string, NodeSighting> {
  return new Map(nodes.map((node) => [node.slug, toSighting(node)]));
}

function toRuntimeTransition(row: PinTransitionEntity): RuntimeTransition {
  return {
    nodeId: row.nodeId,
    pin: row.pin,
    energised: row.energised,
    deviceId: row.deviceId,
    observedAt: row.observedAt,
    isNodeOffline: row.reason === NODE_OFFLINE_REASON,
  };
}

function toSighting(node: Node): NodeSighting {
  return {
    isOnline: node.online,
    lastHeardAt: findLaterInstant(node.lastSeenAt, node.latestReadingAt),
  };
}

function findLaterInstant(...instants: (string | null)[]): Date | null {
  const known = instants
    .filter((instant): instant is string => instant !== null)
    .map((instant) => new Date(instant).getTime());
  return known.length === 0 ? null : new Date(Math.max(...known));
}
