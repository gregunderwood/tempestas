import type { Node } from '@tempestas/domain';

export interface PushedNode {
  node: Node;
  receivedAt: number;
}

export function recordNodePush(
  pushes: ReadonlyMap<string, PushedNode>,
  node: Node,
  receivedAt: number,
): ReadonlyMap<string, PushedNode> {
  return new Map(pushes).set(node.id, { node, receivedAt });
}
