import { NodeKind, NodeStatus, type NodeCapabilities } from '@tempestas/domain';
import {
  NODE_OFFLINE_AFTER_MS,
  acceptsCommands,
  acceptsSamples,
  findContractStanding,
  isNodeOnline,
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
    agentName: 'agent-linux',
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
    agentName: 'agent-linux',
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
  // The most important property here: re-announcing cannot admit, un-admit or undo a rejection.
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
    // A row first seen before boot_id existed.
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

  it('reports an agent upgrade when an old agent first names itself', () => {
    const { outcomes } = patchFromHello(
      registered({ agentName: null }),
      hello(),
    );
    expect(outcomes).toContain('agent-upgraded');
  });

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

// Reporting only the reboot once hid a node dropping every GPIO pin while a device was bound to one.
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

// Three nodes once sat on the screen as online 28 hours after they were last heard from.
describe('isNodeOnline', () => {
  const NOW = new Date('2026-09-10T22:00:00.000Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const MINUTE = 60_000;

  it('is offline when nothing has been heard for longer than the window', () => {
    expect(
      isNodeOnline(
        {
          online: true,
          lastSeenAt: ago(28 * 60 * MINUTE),
          latestReadingAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  // lastSeenAt only advances on an online transition, so alone it would mark this node offline.
  it('is online on recent readings even when it connected hours ago', () => {
    expect(
      isNodeOnline(
        {
          online: true,
          lastSeenAt: ago(9 * 60 * MINUTE),
          latestReadingAt: ago(10_000),
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('is online on a recent connection even with no readings at all', () => {
    expect(
      isNodeOnline(
        { online: true, lastSeenAt: ago(MINUTE), latestReadingAt: null },
        NOW,
      ),
    ).toBe(true);
  });

  it('never revives a node the registry believes offline', () => {
    expect(
      isNodeOnline(
        { online: false, lastSeenAt: NOW, latestReadingAt: NOW },
        NOW,
      ),
    ).toBe(false);
  });

  it('has never been seen at all', () => {
    expect(
      isNodeOnline(
        { online: true, lastSeenAt: null, latestReadingAt: null },
        NOW,
      ),
    ).toBe(false);
  });

  it('treats the cutoff instant itself as still online', () => {
    expect(
      isNodeOnline(
        {
          online: true,
          lastSeenAt: ago(NODE_OFFLINE_AFTER_MS),
          latestReadingAt: null,
        },
        NOW,
      ),
    ).toBe(true);
    expect(
      isNodeOnline(
        {
          online: true,
          lastSeenAt: ago(NODE_OFFLINE_AFTER_MS + 1),
          latestReadingAt: null,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('allows far more than a sample interval or a broker will', () => {
    expect(NODE_OFFLINE_AFTER_MS).toBeGreaterThan(60_000);
    expect(NODE_OFFLINE_AFTER_MS).toBeLessThanOrEqual(10 * MINUTE);
  });
});

describe('findContractStanding', () => {
  it('calls a node on the same minor current', () => {
    expect(findContractStanding(capabilities({ contractMinor: 0 }))).toBe(
      'current',
    );
  });

  // Agents older than the minor field are on minor 0.
  it('reads an absent minor as 0', () => {
    expect(findContractStanding(capabilities())).toBe('current');
  });

  it('calls a node on a newer minor ahead', () => {
    expect(findContractStanding(capabilities({ contractMinor: 1 }))).toBe(
      'ahead',
    );
  });
});
