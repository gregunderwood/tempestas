import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type {
  DayNightStats,
  Node,
  Reading,
  ReadingStats,
  SegmentStats,
} from '@tempestas/domain';
import { NodeStatus } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { NodeDetail } from './node-detail';

function reading(over: Partial<Reading> = {}): Reading {
  return {
    id: 'r1',
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    temperature: 23.8,
    humidity: 63,
    co2: 481,
    createdAt: '2026-09-10T22:39:46.000Z',
    ...over,
  };
}

function statsOf(): ReadingStats {
  return {
    min: {
      temperature: reading({ temperature: 17.5 }),
      humidity: reading({ humidity: 54.9 }),
      co2: reading({ co2: 479 }),
    },
    max: {
      temperature: reading({ temperature: 23.8 }),
      humidity: reading({ humidity: 77.5 }),
      co2: reading({ co2: 866 }),
    },
    average: { temperature: 21.8, humidity: 66.4, co2: 584 },
    from: '2026-09-10T13:30:00.000Z',
    to: '2026-09-10T22:39:00.000Z',
  };
}

/** A period with nothing in it - the normal case for a node that started today. */
function emptyStats(): ReadingStats {
  return {
    min: { temperature: null, humidity: null, co2: null },
    max: { temperature: null, humidity: null, co2: null },
    average: { temperature: null, humidity: null, co2: null },
    from: '2026-09-10T01:30:00.000Z',
    to: '2026-09-10T13:30:00.000Z',
  };
}

function segment(
  kind: 'day' | 'night',
  inProgress: boolean,
  stats: ReadingStats,
): SegmentStats {
  return {
    kind,
    inProgress,
    from: '2026-09-10T13:30:00.000Z',
    to: '2026-09-10T22:39:00.000Z',
    stats,
  };
}

function dayNight(over: Partial<DayNightStats> = {}): DayNightStats {
  return {
    // Oldest first, ending with the period still running.
    periods: [
      segment('day', false, statsOf()),
      segment('night', false, emptyStats()),
      segment('day', true, statsOf()),
    ],
    daylight: {
      startTime: '06:30',
      endTime: '18:30',
      timezone: 'America/Vancouver',
    },
    ...over,
  };
}

function node(): Node {
  return {
    id: 'n1',
    slug: 'elantris',
    displayName: 'elantris',
    kind: 'rpi',
    status: NodeStatus.Admitted,
    online: true,
  } as unknown as Node;
}

function setup(
  opts: {
    stats?: DayNightStats;
    latest?: Reading[];
    live?: Record<string, Reading>;
  } = {},
): HTMLElement {
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          nodes: () => of([node()]),
          latestReadings: () => of(opts.latest ?? [reading()]),
          dayNightStats: () => of(opts.stats ?? dayNight()),
        },
      },
      {
        provide: RealtimeService,
        useValue: {
          readings: signal(opts.live ?? {}),
          deviceState: signal(null),
          status: signal(null),
          connected: signal(true),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('slug', 'elantris');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The period rows of the first metric block, in the order they render. */
function firstBlockRows(el: HTMLElement): HTMLElement[] {
  const block = el.querySelectorAll('tbody')[0];
  return [...block.querySelectorAll<HTMLElement>('tr:not(.metric)')];
}

describe('NodeDetail', () => {
  it('shows the current reading as gauges', () => {
    const el = setup();
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(3);
    expect(el.textContent).toContain('23.8');
  });

  it('shows min, max and average for each metric', () => {
    const text = setup().textContent ?? '';
    for (const value of ['17.5', '23.8', '21.8', '54.9', '77.5', '584']) {
      expect(text).toContain(value);
    }
  });

  // The whole point of the split: a period spanning both averages CO2
  // enrichment together with night heating and describes neither.
  it('shows three alternating periods and no combined figure', () => {
    const el = setup();
    expect(firstBlockRows(el)).toHaveLength(3);
    expect(el.textContent).not.toContain('24 hours');
  });

  // Oldest first, so the table reads forwards in time and ends with now.
  it('puts the running period last and marks it', () => {
    const rows = firstBlockRows(setup());
    expect(rows[2].classList.contains('running')).toBe(true);
    expect(rows[0].classList.contains('running')).toBe(false);
    expect(rows[2].textContent).toContain('Day so far');
  });

  it('says night so far when the running period is night', () => {
    const el = setup({
      stats: dayNight({
        periods: [
          segment('night', false, statsOf()),
          segment('day', false, statsOf()),
          segment('night', true, statsOf()),
        ],
      }),
    });
    expect(el.querySelector('tr.running')?.textContent).toContain(
      'Night so far',
    );
  });

  // Which night is "last" depends on whether it is currently night, so a label
  // that is right half the time is worse than one that never claims it. The
  // dated span carries the identity instead.
  it('does not claim a completed period is "last night"', () => {
    expect(setup().textContent).not.toContain('Last night');
  });

  // The clock time of an extreme matters as much as its value: a peak at 14:00
  // is the greenhouse working, the same peak at 03:00 is a fault.
  it('shows when an extreme happened, not just what it was', () => {
    expect(setup().querySelectorAll('.at').length).toBeGreaterThan(0);
  });

  // Every figure here can legitimately be absent. Zero would read as extremely
  // low CO2, which is the one direction that runs the burner.
  it('renders an empty period as em-dashes, never zeros', () => {
    const empty = firstBlockRows(setup())[1];
    expect(empty.textContent).toContain('—');
    expect(empty.textContent).not.toMatch(/\b0\b/);
  });

  it('says which daylight boundary it split at', () => {
    const text = setup().textContent ?? '';
    expect(text).toContain('06:30');
    expect(text).toContain('America/Vancouver');
  });

  // Same rule as everywhere else: the socket patches what the API established.
  it('prefers a live reading over the fetched one', () => {
    const el = setup({ live: { elantris: reading({ temperature: 31.4 }) } });
    expect(el.textContent).toContain('31.4');
  });

  it('says so plainly when the node has never reported', () => {
    expect(setup({ latest: [] }).textContent).toContain(
      'No readings from this node',
    );
  });

  it('says so plainly when there are no periods to show', () => {
    const el = setup({ stats: dayNight({ periods: [] }) });
    expect(el.textContent).toContain('No day or night period to show');
  });
});
