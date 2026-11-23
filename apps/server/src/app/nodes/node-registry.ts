import {
  MQTT_CONTRACT_MINOR,
  NodeStatus,
  type ContractStanding,
  type NodeCapabilities,
  type NodeId,
  type NodeKind,
} from '@tempestas/domain';

export interface HelloFacts {
  nodeId: NodeId;
  kind: NodeKind;
  agentName: string | null;
  agentVersion: string;
  capabilities: NodeCapabilities;
  bootId: string;
  receivedAt: Date;
}

export interface RegisteredNode {
  slug: NodeId;
  status: NodeStatus;
  kind: NodeKind;
  agentName: string | null;
  agentVersion: string | null;
  capabilities: NodeCapabilities;
  bootId: string | null;
}

export interface NewNodeFields {
  slug: NodeId;
  displayName: string;
  status: NodeStatus;
  kind: NodeKind;
  agentName: string | null;
  agentVersion: string;
  capabilities: NodeCapabilities;
  bootId: string;
  online: boolean;
  lastSeenAt: Date;
}

// No `status`, `displayName`, `location` or `zoneId`: a hello must never write a human-owned field.
export interface HelloPatch {
  kind: NodeKind;
  agentName: string | null;
  agentVersion: string;
  capabilities: NodeCapabilities;
  bootId: string;
  online: boolean;
  lastSeenAt: Date;
}

// A hello can be several of these at once, and reporting only the loudest has hidden a withdrawn pin.
export type HelloOutcome =
  'rebooted' | 'capabilities-changed' | 'agent-upgraded' | 'seen';

type HelloChangeDetector = (
  existing: RegisteredNode,
  hello: HelloFacts,
) => boolean;

const HELLO_CHANGE_DETECTORS: readonly [HelloOutcome, HelloChangeDetector][] = [
  ['rebooted', hasProvablyRebooted],
  [
    'capabilities-changed',
    (existing, hello) => !deepEquals(existing.capabilities, hello.capabilities),
  ],
  [
    'agent-upgraded',
    (existing, hello) =>
      existing.agentName !== hello.agentName ||
      existing.agentVersion !== hello.agentVersion,
  ],
];

// Generous next to a 10 s sample interval and a ~45 s broker will, so a WiFi blip does not flap.
export const NODE_OFFLINE_AFTER_MS = 5 * 60_000;

export function acceptsSamples(status: NodeStatus): boolean {
  return status === NodeStatus.Admitted;
}

// A disabled node may still be shouting on the broker, and it must still get nothing back.
export function acceptsCommands(status: NodeStatus): boolean {
  return status === NodeStatus.Admitted;
}

export function newNodeFromHello(hello: HelloFacts): NewNodeFields {
  return {
    slug: hello.nodeId,
    // The slug until a human names it, so the nodes list always has something to render.
    displayName: hello.nodeId,
    status: NodeStatus.Pending,
    kind: hello.kind,
    agentName: hello.agentName,
    agentVersion: hello.agentVersion,
    capabilities: hello.capabilities,
    bootId: hello.bootId,
    online: true,
    lastSeenAt: hello.receivedAt,
  };
}

export function patchFromHello(
  existing: RegisteredNode,
  hello: HelloFacts,
): { patch: HelloPatch; outcomes: HelloOutcome[] } {
  return {
    patch: {
      kind: hello.kind,
      agentName: hello.agentName,
      agentVersion: hello.agentVersion,
      capabilities: hello.capabilities,
      bootId: hello.bootId,
      online: true,
      lastSeenAt: hello.receivedAt,
    },
    outcomes: classifyHello(existing, hello),
  };
}

export function findContractStanding(
  capabilities: NodeCapabilities,
): ContractStanding {
  const nodeMinor = capabilities.contractMinor ?? 0;
  if (nodeMinor < MQTT_CONTRACT_MINOR) {
    return 'behind';
  }
  return nodeMinor > MQTT_CONTRACT_MINOR ? 'ahead' : 'current';
}

export function pinsWithdrawn(
  previous: NodeCapabilities,
  next: NodeCapabilities,
): number[] {
  const before = new Set(previous.gpio?.pins ?? []);
  const after = new Set(next.gpio?.pins ?? []);
  return [...before].filter((pin) => !after.has(pin)).sort(ascending);
}

// The stored flag misses a node that vanished while the controller was down, so it needs recent evidence too.
export interface NodeOnlineEvidence {
  online: boolean;
  lastSeenAt: Date | null;
  latestReadingAt: Date | null;
}

export function isNodeOnline(node: NodeOnlineEvidence, now: Date): boolean {
  if (!node.online) {
    return false;
  }
  const cutoff = now.getTime() - NODE_OFFLINE_AFTER_MS;
  const lastSeenMs = node.lastSeenAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const latestReadingMs =
    node.latestReadingAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  return Math.max(lastSeenMs, latestReadingMs) >= cutoff;
}

function classifyHello(
  existing: RegisteredNode,
  hello: HelloFacts,
): HelloOutcome[] {
  const outcomes = HELLO_CHANGE_DETECTORS.filter(([, hasChanged]) =>
    hasChanged(existing, hello),
  ).map(([outcome]) => outcome);
  return outcomes.length > 0 ? outcomes : ['seen'];
}

// A null bootId predates the column, so a reboot is not provable and claiming one would lie in the log.
function hasProvablyRebooted(
  existing: RegisteredNode,
  hello: HelloFacts,
): boolean {
  return existing.bootId !== null && existing.bootId !== hello.bootId;
}

function ascending(first: number, second: number): number {
  return first - second;
}

// Key-order-insensitive, because Postgres does not preserve jsonb object key order.
function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!isObject(left) || !isObject(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return arraysEqual(left, right);
  }
  return recordsEqual(
    left as Record<string, unknown>,
    right as Record<string, unknown>,
  );
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

// Order-sensitive: jsonb preserves array order, so a reordered pin list is a real edit.
function arraysEqual(left: unknown[], right: unknown[]): boolean {
  return (
    left.length === right.length &&
    left.every((element, index) => deepEquals(element, right[index]))
  );
}

function recordsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => deepEquals(left[key], right[key]));
}
