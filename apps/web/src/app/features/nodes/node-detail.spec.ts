import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type {
  DayNightStats,
  Device,
  Node,
  Reading,
  ReadingStats,
  SegmentStats,
} from '@tempestas/domain';
import { NodeStatus } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { fakeRealtime } from '../../testing/fake-realtime';
import { NodeDetail } from './node-detail';
import { PageHeading } from '../../core/page-heading';

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
    nextBoundary: '2026-09-11T01:30:00.000Z',
    daylight: {
      startTime: '06:30',
      endTime: '18:30',
      timezone: 'America/Vancouver',
    },
    ...over,
  };
}

function node(over: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    slug: 'elantris',
    displayName: 'elantris',
    kind: 'rpi',
    status: NodeStatus.Admitted,
    online: true,
    ...over,
  } as unknown as Node;
}

let statsCalls = 0;

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    nodeId: 'elantris',
    zoneId: 'z1',
    name: 'CO2 Generator',
    description: null,
    gpio: 5,
    onDelayDuration: 300,
    onAt: null,
    offAt: null,
    onLevel: 0,
    rulesEnabled: true,
    role: 'co2_generator',
    isOn: false,
    canTurnOn: true,
    canTurnOnAt: null,
    ...over,
  } as Device;
}

function setup(
  opts: {
    stats?: DayNightStats;
    latest?: Reading[];
    live?: Record<string, Reading>;
    devices?: Device[];
    node?: Node;
    slug?: string;
  } = {},
): HTMLElement {
  statsCalls = 0;
  // Some tests render twice to compare two inputs, and TestBed refuses to be
  // reconfigured once it has been instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          nodes: () => of([opts.node ?? node()]),
          latestReadings: () => of(opts.latest ?? [reading()]),
          dayNightStats: () => {
            statsCalls++;
            return of(opts.stats ?? dayNight());
          },
          devices: () => of(opts.devices ?? []),
        },
      },
      {
        provide: RealtimeService,
        useValue: fakeRealtime({ readings: signal(opts.live ?? {}) }),
      },
    ],
  });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('slug', opts.slug ?? 'elantris');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The period rows of the first metric block, in the order they render. */
function firstBlockRows(el: HTMLElement): HTMLElement[] {
  const block = el.querySelectorAll('tbody')[0];
  return [...block.querySelectorAll<HTMLElement>('tr:not(.metric)')];
}

describe('NodeDetail', () => {
  it('names itself in the top bar, with its kind and whether it is online', () => {
    setup({ node: node({ displayName: 'Greenhouse Pi', online: false }) });
    expect(TestBed.inject(PageHeading).text()).toEqual({
      heading: 'Greenhouse Pi',
      subtitle: 'elantris · rpi · offline',
    });
  });

  it('falls back to its slug in the top bar while the node is unknown', () => {
    setup({ slug: 'braize' });
    expect(TestBed.inject(PageHeading).text()).toEqual({
      heading: 'braize',
      subtitle: '',
    });
  });

  it('shows the current reading as gauges', () => {
    const el = setup();
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(3);
    expect(el.textContent).toContain('23.8');
  });

  // The pumphouse: three pipe probes on one node, temperature only.
  it('shows a gauge row per sensor, and only the metrics it has', () => {
    const probe = (sensorId: string, temperature: number) =>
      reading({
        id: sensorId,
        nodeId: 'pumphouse',
        sensorId,
        temperature,
        humidity: null,
        co2: null,
      });
    const temperatureOnly = (sensorId: string) => ({
      sensorId,
      kind: 'ds18b20',
      metrics: ['temperature' as const],
      sampleIntervalMs: 30_000,
    });
    const el = setup({
      slug: 'pumphouse',
      latest: [probe('28-b', 4.2), probe('28-a', 3.1), reading()],
      node: node({
        slug: 'pumphouse',
        capabilities: {
          contractVersion: 1,
          hasRtc: true,
          sensors: [temperatureOnly('28-a'), temperatureOnly('28-b')],
        },
      }),
    });
    const names = [...el.querySelectorAll('.sensor__name')].map((n) =>
      n.textContent?.trim(),
    );
    expect(names).toEqual(['28-a', '28-b']);
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(2);
    // No humidity or CO2 block of dashes under a node that has neither.
    expect(el.querySelectorAll('tbody')).toHaveLength(1);
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

  // The period running now is what somebody opens this screen to see.
  it('puts the running period at the top and marks it', () => {
    const rows = firstBlockRows(setup());
    expect(rows[0].classList.contains('running')).toBe(true);
    expect(rows[0].textContent).toContain('Day so far');
    expect(rows[2].classList.contains('running')).toBe(false);
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
    // The night between the two days, which the fixture leaves empty.
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
    const el = setup({
      live: { 'elantris/scd4x-0': reading({ temperature: 31.4 }) },
    });
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

  // The gauges are pushed over the socket; these figures are a query. Left
  // alone the table freezes while the gauges keep moving, and the running
  // period is still accumulating so it drifts further the longer you watch.
  describe('keeping the figures current', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('re-queries on a slow timer', () => {
      setup();
      expect(statsCalls).toBe(1);
      vi.advanceTimersByTime(60_000);
      expect(statsCalls).toBe(2);
      vi.advanceTimersByTime(60_000);
      expect(statsCalls).toBe(3);
    });

    // Every row shifts the moment the running period ends.
    it('re-queries when the period boundary passes', () => {
      vi.setSystemTime(new Date('2026-09-11T01:29:00.000Z'));
      setup();
      expect(statsCalls).toBe(1);
      // One minute to the boundary, plus the second of slack.
      vi.advanceTimersByTime(61_500);
      expect(statsCalls).toBeGreaterThanOrEqual(2);
    });

    // Asserted on the timers themselves, not on the request count: the
    // subscription is torn down separately, so counting requests passes even
    // when the interval is left running for the life of the page.
    it('clears its timers once the screen is gone', () => {
      // Pinned before the fixture's boundary. On the real clock the boundary
      // is in the past, no timeout is armed, and the count of two is wrong.
      vi.setSystemTime(new Date('2026-09-10T23:00:00.000Z'));
      setup();
      // Two: the slow refresh interval and the boundary timeout.
      expect(vi.getTimerCount()).toBe(2);
      TestBed.resetTestingModule();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('NodeDetail relays', () => {
  it('lists the relays on this node with their pin and role', () => {
    const text = setup({ devices: [device()] }).textContent ?? '';
    expect(text).toContain('CO2 Generator');
    expect(text).toContain('BCM 5');
    expect(text).toContain('co2_generator');
  });

  // Colour is not readable on a phone in sunlight, and this one means a
  // propane burner is alight.
  it('states an energised relay in words', () => {
    const el = setup({ devices: [device({ isOn: true })] });
    expect(el.querySelector('.relay__state')?.textContent?.trim()).toBe('ON');
    expect(el.querySelector('.relay--on')).not.toBeNull();
  });

  // An idle relay under manual control and one the rules engine is deciding
  // about look identical otherwise.
  it('says whether anything is driving it', () => {
    expect(setup({ devices: [device()] }).textContent).toContain('automatic');
    expect(
      setup({ devices: [device({ rulesEnabled: false })] }).textContent,
    ).toContain('manual');
  });

  // The interlock is invisible otherwise, and "why is it not coming on?" is
  // exactly the question it produces.
  it('shows the minimum-off hold when one is in force', () => {
    const el = setup({
      devices: [
        device({
          isOn: false,
          canTurnOn: false,
          canTurnOnAt: '2026-09-10T22:05:00.000Z',
        }),
      ],
    });
    expect(el.textContent).toContain('held off until');
    expect(el.textContent).toContain('300s minimum off');
  });

  it('does not claim a hold when the device is free to turn on', () => {
    expect(setup({ devices: [device()] }).textContent).not.toContain(
      'held off until',
    );
  });

  it('only lists relays belonging to this node', () => {
    const el = setup({
      devices: [
        device({ id: 'other', nodeId: 'elsewhere', name: 'Other Relay' }),
      ],
    });
    expect(el.textContent).not.toContain('Other Relay');
  });

  it('shows no relay card at all when the node has none', () => {
    expect(setup().querySelector('.relays')).toBeNull();
  });
});
