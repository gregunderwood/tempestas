import type { NodeHealth } from '@tempestas/domain';
import {
  buildHealthEventRows,
  describeEventCounts,
  describeReadingCoverage,
  describeTimeWithoutReadings,
} from './node-health-rows';

const REPORT = { days: 30, generatedAt: '2026-11-24T19:00:00.000Z' };

function patjiHealth(overrides: Partial<NodeHealth> = {}): NodeHealth {
  return {
    nodeId: 'patji',
    nodeName: 'Pumphouse Pi',
    timezone: 'America/Regina',
    hasSensors: true,
    firstReadingAt: '2026-10-25T19:00:10.000Z',
    gaps: [],
    reboots: [],
    versionChanges: [],
    ...overrides,
  };
}

const OUTAGE_NIGHT = {
  from: '2026-11-12T08:30:00.000Z',
  to: '2026-11-12T12:00:00.000Z',
  minutes: 210,
  isOngoing: false,
};

describe('buildHealthEventRows', () => {
  it("merges gaps, reboots and updates newest first, in the node's timezone", () => {
    const rows = buildHealthEventRows(
      patjiHealth({
        gaps: [OUTAGE_NIGHT],
        reboots: [{ at: '2026-11-12T12:00:00.000Z' }],
        versionChanges: [
          {
            fromVersion: '1.0.3',
            toVersion: '1.1.0',
            isRollBack: false,
            at: '2026-11-20T18:00:00.000Z',
          },
        ],
      }),
    );
    expect(rows).toEqual([
      {
        at: '2026-11-20T18:00:00.000Z',
        kind: 'update',
        when: 'Fri 20 Nov, 12:00',
        what: 'Updated agent 1.0.3 → 1.1.0',
        length: '—',
      },
      {
        at: '2026-11-12T12:00:00.000Z',
        kind: 'reboot',
        when: 'Thu 12 Nov, 06:00',
        what: 'Rebooted',
        length: '—',
      },
      {
        at: '2026-11-12T08:30:00.000Z',
        kind: 'gap',
        when: 'Thu 12 Nov, 02:30',
        what: 'No readings',
        length: '3 h 30 min',
      },
    ]);
  });

  it('says a gap still running is still silent', () => {
    const [row] = buildHealthEventRows(
      patjiHealth({
        gaps: [
          {
            from: '2026-11-24T18:00:00.000Z',
            to: REPORT.generatedAt,
            minutes: 60,
            isOngoing: true,
          },
        ],
      }),
    );
    expect(row.what).toBe('No readings since, still silent');
    expect(row.length).toBe('1 h 0 min');
  });

  it('names a roll-back, and an update from an unknown version', () => {
    const [row] = buildHealthEventRows(
      patjiHealth({
        versionChanges: [
          {
            fromVersion: null,
            toVersion: '1.0.3',
            isRollBack: true,
            at: '2026-11-20T18:00:00.000Z',
          },
        ],
      }),
    );
    expect(row.what).toBe('Rolled back agent unknown → 1.0.3');
  });
});

describe('describeEventCounts', () => {
  it('counts each kind, with nothing to report as no', () => {
    expect(
      describeEventCounts(
        patjiHealth({ gaps: [OUTAGE_NIGHT, OUTAGE_NIGHT] }),
        30,
      ),
    ).toBe('2 gaps, no reboots, no agent updates in the last 30 days.');
  });

  it('counts only updates for a node with no sensors', () => {
    expect(describeEventCounts(patjiHealth({ hasSensors: false }), 7)).toBe(
      'No agent updates in the last 7 days.',
    );
  });
});

describe('describeTimeWithoutReadings', () => {
  it('adds up every gap', () => {
    expect(
      describeTimeWithoutReadings(
        patjiHealth({
          gaps: [OUTAGE_NIGHT, { ...OUTAGE_NIGHT, minutes: 30 }],
        }),
      ),
    ).toBe('4 h 0 min without readings');
  });

  it('is null with no gaps', () => {
    expect(describeTimeWithoutReadings(patjiHealth())).toBeNull();
  });
});

describe('describeReadingCoverage', () => {
  it('is null when readings cover the whole period', () => {
    expect(describeReadingCoverage(patjiHealth(), REPORT)).toBeNull();
  });

  it('says when the readings start partway through', () => {
    expect(
      describeReadingCoverage(
        patjiHealth({ firstReadingAt: '2026-11-18T19:00:00.000Z' }),
        REPORT,
      ),
    ).toBe('Readings start 18 Nov.');
  });

  it('says when there were no readings at all', () => {
    expect(
      describeReadingCoverage(patjiHealth({ firstReadingAt: null }), REPORT),
    ).toBe('No readings in the last 30 days.');
  });

  it('says a node with no sensors has nothing to read gaps from', () => {
    expect(
      describeReadingCoverage(patjiHealth({ hasSensors: false }), REPORT),
    ).toBe('No sensors, so no readings to find gaps or reboots in.');
  });
});
