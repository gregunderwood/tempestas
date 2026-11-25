import type { NodeHealth } from '@tempestas/domain';
import type { NodeReadingSpan, ReadingBreak } from '../readings/reading-breaks';
import {
  summariseNodeHealth,
  type HealthNode,
  type NodeHealthHistory,
  type NodeVersionChange,
} from './node-health';

const NOW = new Date('2026-11-24T19:00:00Z');
const GAP_MINUTES = 5;

const PATJI: HealthNode = {
  nodeId: 'patji',
  nodeName: 'Pumphouse Pi',
  timezone: 'America/Vancouver',
  hasSensors: true,
};

const ELANTRIS: HealthNode = { ...PATJI, nodeId: 'elantris' };

function gapBreak(previousAt: string, at: string): ReadingBreak {
  return {
    nodeId: PATJI.nodeId,
    previousAt: new Date(previousAt),
    at: new Date(at),
    isGap: true,
    isNewBoot: false,
  };
}

function bootBreak(previousAt: string, at: string): ReadingBreak {
  return { ...gapBreak(previousAt, at), isGap: false, isNewBoot: true };
}

function span(firstAt: string, lastAt: string): NodeReadingSpan {
  return {
    nodeId: PATJI.nodeId,
    firstAt: new Date(firstAt),
    lastAt: new Date(lastAt),
  };
}

function versionChange(at: string, toVersion: string): NodeVersionChange {
  return {
    nodeId: PATJI.nodeId,
    fromVersion: '1.0.0',
    toVersion,
    isRollBack: false,
    at,
  };
}

function summarise(history: Partial<NodeHealthHistory> = {}): NodeHealth[] {
  return summariseNodeHealth({
    nodes: [PATJI],
    breaks: [],
    readingSpans: [span('2026-10-25T19:00:00Z', '2026-11-24T18:59:50Z')],
    versionChanges: [],
    gapMinutes: GAP_MINUTES,
    now: NOW,
    ...history,
  });
}

describe('summariseNodeHealth', () => {
  it('reports a node that read steadily with no gaps, reboots or updates', () => {
    const [patji] = summarise();
    expect(patji).toEqual({
      ...PATJI,
      firstReadingAt: '2026-10-25T19:00:00.000Z',
      gaps: [],
      reboots: [],
      versionChanges: [],
    });
  });

  it('lists each gap with its start and length, newest first', () => {
    const [patji] = summarise({
      breaks: [
        gapBreak('2026-11-12T09:30:00Z', '2026-11-12T13:00:00Z'),
        gapBreak('2026-11-20T10:00:00Z', '2026-11-20T10:07:30Z'),
      ],
    });
    expect(patji.gaps).toEqual([
      {
        from: '2026-11-20T10:00:00.000Z',
        to: '2026-11-20T10:07:30.000Z',
        minutes: 8,
        isOngoing: false,
      },
      {
        from: '2026-11-12T09:30:00.000Z',
        to: '2026-11-12T13:00:00.000Z',
        minutes: 210,
        isOngoing: false,
      },
    ]);
  });

  it('counts a silence that runs up to now as an ongoing gap', () => {
    const [patji] = summarise({
      readingSpans: [span('2026-10-25T19:00:00Z', '2026-11-24T18:00:00Z')],
    });
    expect(patji.gaps).toEqual([
      {
        from: '2026-11-24T18:00:00.000Z',
        to: NOW.toISOString(),
        minutes: 60,
        isOngoing: true,
      },
    ]);
  });

  it('leaves a node with no readings in the period without gaps to list', () => {
    const [patji] = summarise({ readingSpans: [] });
    expect(patji.firstReadingAt).toBeNull();
    expect(patji.gaps).toEqual([]);
  });

  it('lists a reboot at the first reading of each new boot, newest first', () => {
    const [patji] = summarise({
      breaks: [
        bootBreak('2026-11-10T08:00:00Z', '2026-11-10T08:00:40Z'),
        bootBreak('2026-11-18T08:00:00Z', '2026-11-18T08:00:40Z'),
      ],
    });
    expect(patji.reboots).toEqual([
      { at: '2026-11-18T08:00:40.000Z' },
      { at: '2026-11-10T08:00:40.000Z' },
    ]);
    expect(patji.gaps).toEqual([]);
  });

  it('counts a long reboot as both a gap and a reboot', () => {
    const [patji] = summarise({
      breaks: [
        {
          ...gapBreak('2026-11-10T08:00:00Z', '2026-11-10T08:20:00Z'),
          isNewBoot: true,
        },
      ],
    });
    expect(patji.gaps.map((gap) => gap.minutes)).toEqual([20]);
    expect(patji.reboots).toEqual([{ at: '2026-11-10T08:20:00.000Z' }]);
  });

  it("keeps each node's breaks and updates to itself", () => {
    const [elantris, patji] = summarise({
      nodes: [ELANTRIS, PATJI],
      breaks: [gapBreak('2026-11-12T09:30:00Z', '2026-11-12T13:00:00Z')],
      versionChanges: [versionChange('2026-11-15T12:00:00.000Z', '1.1.0')],
    });
    expect(elantris.gaps).toEqual([]);
    expect(elantris.firstReadingAt).toBeNull();
    expect(elantris.versionChanges).toEqual([]);
    expect(patji.gaps).toHaveLength(1);
    expect(patji.versionChanges).toHaveLength(1);
  });

  it('lists agent version changes newest first, without the node id', () => {
    const [patji] = summarise({
      versionChanges: [
        versionChange('2026-11-01T12:00:00.000Z', '1.0.1'),
        versionChange('2026-11-15T12:00:00.000Z', '1.1.0'),
      ],
    });
    expect(patji.versionChanges).toEqual([
      {
        fromVersion: '1.0.0',
        toVersion: '1.1.0',
        isRollBack: false,
        at: '2026-11-15T12:00:00.000Z',
      },
      {
        fromVersion: '1.0.0',
        toVersion: '1.0.1',
        isRollBack: false,
        at: '2026-11-01T12:00:00.000Z',
      },
    ]);
  });
});
