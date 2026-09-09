import { NodeKind, NodeStatus, type NodeCapabilities } from '@tempestas/domain';
import {
  acceptsCommands,
  acceptsSamples,
  newNodeFromHello,
  patchFromHello,
  type HelloFacts,
  type RegisteredNode,
} from './node-registry';

const AT = new Date('2026-01-10T12:00:00Z');

function capabilities(
  overrides: Partial<NodeCapabilities> = {},
): NodeCapabilities {
  return {
    contractVersion: 1,
    gpio: { pins: [12, 16, 20, 21, 26], supportsReadback: true },
    sensors: [
      {
        sensorId: 'scd4x-0',
        kind: 'scd4x',
        metrics: ['temperature', 'humidity', 'co2'],
        sampleIntervalMs: 10_000,
      },
    ],
    hasRtc: true,
    ...overrides,
  };
}

function hello(overrides: Partial<HelloFacts> = {}): HelloFacts {
  return {
    nodeId: 'elantris',
    kind: NodeKind.RaspberryPi,
    agentVersion: '1.0.0',
    capabilities: capabilities(),
    bootId: 'boot-1',
    receivedAt: AT,
    ...overrides,
  };
}

function registered(overrides: Partial<RegisteredNode> = {}): RegisteredNode {
  return {
    slug: 'elantris',
    status: NodeStatus.Admitted,
    kind: NodeKind.RaspberryPi,
    agentVersion: '1.0.0',
    capabilities: capabilities(),
    bootId: 'boot-1',
    ...overrides,
  };
}

describe('the admission gate', () => {
  it('believes readings from an admitted node only', () => {
    expect(acceptsSamples(NodeStatus.Admitted)).toBe(true);
    expect(acceptsSamples(NodeStatus.Pending)).toBe(false);
    expect(acceptsSamples(NodeStatus.Disabled)).toBe(false);
  });

  it('commands an admitted node only', () => {
    expect(acceptsCommands(NodeStatus.Admitted)).toBe(true);
    expect(acceptsCommands(NodeStatus.Pending)).toBe(false);
    expect(acceptsCommands(NodeStatus.Disabled)).toBe(false);
  });
});

describe('newNodeFromHello', () => {
  it('lands an unknown node as pending, never admitted', () => {
    expect(newNodeFromHello(hello())).toMatchObject({
      slug: 'elantris',
      status: NodeStatus.Pending,
      online: true,
      lastSeenAt: AT,
      bootId: 'boot-1',
    });
  });

  it('names it after its slug so the nodes list can render it', () => {
    expect(newNodeFromHello(hello({ nodeId: 'ghost' })).displayName).toBe(
      'ghost',
    );
  });
});

describe('patchFromHello', () => {
  // The single most important property in this file: a node cannot admit
  // itself, un-admit itself, or undo a human's rejection by re-announcing.
  it('cannot touch status, whatever the node claims', () => {
    for (const status of [
      NodeStatus.Pending,
      NodeStatus.Admitted,
      NodeStatus.Disabled,
    ]) {
      const { patch } = patchFromHello(registered({ status }), hello());
      expect(Object.keys(patch)).not.toContain('status');
    }
  });

  it('cannot rename what an operator named, or move its zone', () => {
    const { patch } = patchFromHello(registered(), hello());
    expect(Object.keys(patch)).not.toContain('displayName');
    expect(Object.keys(patch)).not.toContain('location');
    expect(Object.keys(patch)).not.toContain('zoneId');
  });

  it('does take the node-owned facts, and marks it seen', () => {
    const { patch } = patchFromHello(
      registered({ agentVersion: '0.9.0' }),
      hello({ agentVersion: '1.0.0' }),
    );
    expect(patch).toMatchObject({
      agentVersion: '1.0.0',
      online: true,
      lastSeenAt: AT,
    });
  });

  it('reports a reboot when the bootId changes', () => {
    const { outcome } = patchFromHello(
      registered(),
      hello({ bootId: 'boot-2' }),
    );
    expect(outcome).toBe('rebooted');
  });

  it('will not claim a reboot it cannot prove', () => {
    // A row first seen before boot_id existed. Inventing a reboot here would
    // put a lie in the log used to diagnose the next outage.
    const { outcome } = patchFromHello(registered({ bootId: null }), hello());
    expect(outcome).toBe('seen');
  });

  it('reports a capability change when the exposed pins move', () => {
    const { outcome } = patchFromHello(
      registered(),
      hello({
        capabilities: capabilities({
          gpio: { pins: [12, 16], supportsReadback: true },
        }),
      }),
    );
    expect(outcome).toBe('capabilities-changed');
  });

  it('reports an agent upgrade when only the version moved', () => {
    const { outcome } = patchFromHello(
      registered(),
      hello({ agentVersion: '1.1.0' }),
    );
    expect(outcome).toBe('agent-upgraded');
  });

  // capabilities round-trip through jsonb, and Postgres does not preserve
  // object key order. A JSON.stringify comparison would log a capability
  // change on every single restart.
  it('is not fooled by jsonb reordering the keys', () => {
    const reordered = {
      hasRtc: true,
      sensors: [
        {
          sampleIntervalMs: 10_000,
          metrics: ['temperature', 'humidity', 'co2'],
          kind: 'scd4x',
          sensorId: 'scd4x-0',
        },
      ],
      gpio: { supportsReadback: true, pins: [12, 16, 20, 21, 26] },
      contractVersion: 1,
    } as unknown as NodeCapabilities;

    const { outcome } = patchFromHello(
      registered(),
      hello({ capabilities: reordered }),
    );
    expect(outcome).toBe('seen');
  });
});
