import type { NodeId } from '@tempestas/domain';

export function toPinKey(nodeId: NodeId, pin: number): string {
  return `${nodeId}:${pin}`;
}

export function isPinKeyOfNode(pinKey: string, nodeId: NodeId): boolean {
  return pinKey.startsWith(`${nodeId}:`);
}
