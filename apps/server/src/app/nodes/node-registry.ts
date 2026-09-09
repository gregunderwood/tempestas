import {
  NodeStatus,
  type NodeCapabilities,
  type NodeId,
  type NodeKind,
} from '@tempestas/domain';

/**
 * The registry decisions, as pure functions.
 *
 * Everything here is a policy question with a safety consequence - "may this
 * node's readings be believed?", "may this node be commanded?", "did a `hello`
 * just silently re-admit a node a human rejected?" - so it lives away from the
 * repository and the MQTT subscription and is asserted directly.
 *
 * The division of ownership this file encodes:
 *   - the NODE owns kind, capabilities, agentVersion, bootId, online, lastSeenAt
 *   - a HUMAN owns status, displayName, location, zoneId
 * A `hello` may therefore never move a node's status. That is the whole point
 * of the admission gate.
 */

/** What a `hello` asserts, with the transport concerns already stripped off. */
export interface HelloFacts {
  nodeId: NodeId;
  kind: NodeKind;
  agentVersion: string;
  capabilities: NodeCapabilities;
  /** Changes on every node restart, so a bounce is detectable. */
  bootId: string;
  receivedAt: Date;
}

/** The registry-relevant subset of a stored node. */
export interface RegisteredNode {
  slug: NodeId;
  status: NodeStatus;
  kind: NodeKind;
  agentVersion: string | null;
  capabilities: NodeCapabilities;
  bootId: string | null;
}

export interface NewNodeFields {
  slug: NodeId;
  displayName: string;
  status: NodeStatus;
  kind: NodeKind;
  agentVersion: string;
  capabilities: NodeCapabilities;
  bootId: string;
  online: boolean;
  lastSeenAt: Date;
}

/** Only the fields a `hello` is allowed to write. Note the absent `status`. */
export interface HelloPatch {
  kind: NodeKind;
  agentVersion: string;
  capabilities: NodeCapabilities;
  bootId: string;
  online: boolean;
  lastSeenAt: Date;
}

/**
 * Why this hello was interesting, if it was. At one hello per node restart this
 * is cheap to log - but `seen` stays at debug, because a node re-announcing on
 * every reconnect must not bury the line that says a new node needs admitting.
 */
export type HelloOutcome =
  'rebooted' | 'capabilities-changed' | 'agent-upgraded' | 'seen';

/** Admitted only: a pending node's readings are discarded, not merely ignored. */
export function acceptsSamples(status: NodeStatus): boolean {
  return status === NodeStatus.Admitted;
}

/**
 * Admitted only. A `disabled` node is one a human rejected - it may still be
 * shouting on the broker, and it must still get nothing back.
 */
export function acceptsCommands(status: NodeStatus): boolean {
  return status === NodeStatus.Admitted;
}

/**
 * An unknown slug becomes a `pending` row rather than an error, so that the
 * enrollment flow is "plug it in, then click admit" and never "hand-write a
 * row". Pending is inert: no commands out, no readings in.
 */
export function newNodeFromHello(hello: HelloFacts): NewNodeFields {
  return {
    slug: hello.nodeId,
    // The slug until a human names it. Never left empty - the nodes list has to
    // render something for a node nobody has looked at yet.
    displayName: hello.nodeId,
    status: NodeStatus.Pending,
    kind: hello.kind,
    agentVersion: hello.agentVersion,
    capabilities: hello.capabilities,
    bootId: hello.bootId,
    online: true,
    lastSeenAt: hello.receivedAt,
  };
}

/**
 * The patch a `hello` from a KNOWN node produces.
 *
 * `status`, `displayName`, `location` and `zoneId` are deliberately not in the
 * return type: a node that re-announces itself must not be able to re-admit
 * itself, un-admit itself, or rename what an operator called it.
 */
export function patchFromHello(
  existing: RegisteredNode,
  hello: HelloFacts,
): { patch: HelloPatch; outcome: HelloOutcome } {
  return {
    patch: {
      kind: hello.kind,
      agentVersion: hello.agentVersion,
      capabilities: hello.capabilities,
      bootId: hello.bootId,
      online: true,
      lastSeenAt: hello.receivedAt,
    },
    outcome: classifyHello(existing, hello),
  };
}

function classifyHello(
  existing: RegisteredNode,
  hello: HelloFacts,
): HelloOutcome {
  // A null bootId is a node first seen before this field existed, so a reboot
  // is not provable. Claiming one would be a lie in a log used for diagnosis.
  if (existing.bootId !== null && existing.bootId !== hello.bootId)
    return 'rebooted';
  if (!deepEquals(existing.capabilities, hello.capabilities))
    return 'capabilities-changed';
  if (existing.agentVersion !== hello.agentVersion) return 'agent-upgraded';
  return 'seen';
}

/**
 * Key-order-insensitive, because `capabilities` round-trips through jsonb and
 * Postgres does not preserve object key order. A JSON.stringify comparison
 * would report a capability change on every restart of the server.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    // Order-sensitive: jsonb preserves array order, so a reordered pin list is
    // a real edit to the node's config and worth one log line.
    return a.length === b.length && a.every((v, i) => deepEquals(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // Compared as SETS of keys, which is the whole reason this function exists.
  const ka = Object.keys(left).sort();
  const kb = Object.keys(right).sort();
  if (ka.length !== kb.length) return false;
  if (ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => deepEquals(left[k], right[k]));
}
