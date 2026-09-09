import { NodeKind, NodeStatus, type NodeCapabilities } from '@tempestas/domain';
import {
  acceptsCommands,
  acceptsSamples,
  newNodeFromHello,
  patchFromHello,
  pinsWithdrawn,
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
    const { outcomes } = patchFromHello(
      registered(),
      hello({ bootId: 'boot-2' }),
    );
    expect(outcomes).toContain('rebooted');
  });

  it('will not claim a reboot it cannot prove', () => {
    // A row first seen before boot_id existed. Inventing a reboot here would
    // put a lie in the log used to diagnose the next outage.
    const { outcomes } = patchFromHello(registered({ bootId: null }), hello());
    expect(outcomes).toEqual(['seen']);
  });

  it('reports a capability change when the exposed pins move', () => {
    const { outcomes } = patchFromHello(
      registered(),
      hello({
        capabilities: capabilities({
          gpio: { pins: [12, 16], supportsReadback: true },
        }),
      }),
    );
    expect(outcomes).toContain('capabilities-changed');
  });

  it('reports an agent upgrade when only the version moved', () => {
    const { outcomes } = patchFromHello(
      registered(),
      hello({ agentVersion: '1.1.0' }),
    );
    expect(outcomes).toContain('agent-upgraded');
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

    const { outcomes } = patchFromHello(
      registered(),
      hello({ capabilities: reordered }),
    );
    expect(outcomes).toEqual(['seen']);
  });
});

// Found by running the real agent: an agent restarting with new capabilities is
// BOTH a reboot and a capability change. Reporting only the reboot hid a node
// dropping every GPIO pin it had while a device was still bound to one.
describe('a hello can be several things at once', () => {
  it('reports a reboot AND a capability change together', () => {
    const { outcomes } = patchFromHello(
      registered(),
      hello({
        bootId: 'boot-2',
        capabilities: capabilities({ gpio: undefined }),
      }),
    );
    expect(outcomes).toEqual(
      expect.arrayContaining(['rebooted', 'capabilities-changed']),
    );
  });

  it('reports all three when the agent is upgraded too', () => {
    const { outcomes } = patchFromHello(
      registered(),
      hello({
        bootId: 'boot-2',
        agentVersion: '2.0.0',
        capabilities: capabilities({ gpio: undefined }),
      }),
    );
    expect(outcomes.sort()).toEqual([
      'agent-upgraded',
      'capabilities-changed',
      'rebooted',
    ]);
  });
});

describe('pinsWithdrawn', () => {
  it('names the pins a node used to expose and no longer does', () => {
    const before = capabilities({
      gpio: { pins: [12, 16, 20], supportsReadback: true },
    });
    const after = capabilities({
      gpio: { pins: [12], supportsReadback: true },
    });
    expect(pinsWithdrawn(before, after)).toEqual([16, 20]);
  });

  // The case that actually happened: a node became sensor-only.
  it('treats losing gpio entirely as withdrawing every pin', () => {
    const before = capabilities({
      gpio: { pins: [16], supportsReadback: true },
    });
    expect(pinsWithdrawn(before, capabilities({ gpio: undefined }))).toEqual([
      16,
    ]);
  });

  it('is empty when pins are only added', () => {
    const before = capabilities({
      gpio: { pins: [16], supportsReadback: true },
    });
    const after = capabilities({
      gpio: { pins: [16, 20], supportsReadback: true },
    });
    expect(pinsWithdrawn(before, after)).toEqual([]);
  });
});
