import { TestBed } from '@angular/core/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, type Observable } from 'rxjs';
import type {
  DayNightStats,
  Device,
  Node,
  Reading,
  ReadingStats,
  SegmentStats,
} from '@tempestas/domain';
import { NO_UPDATE_SUMMARY, NodeStatus } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  fakeRealtime,
  pushNode,
  type FakeRealtime,
} from '../../testing/fake-realtime';
import { NodeDetail, STATS_REFRESH_THROTTLE_MILLISECONDS } from './node-detail';
import { PageHeading } from '../../core/page-heading';

const PAST_BOUNDARY_AND_SLACK_MILLISECONDS = 61_500;
const THROTTLE_WINDOW_AND_BOUNDARY_TIMEOUT = 2;
const SCREEN_OPENED_AT = new Date('2026-09-10T22:39:50.000Z');
const BROWSER_CLOCK_AHEAD_MILLISECONDS = 60 * 60 * 1000;
const TEN_SECONDS_MILLISECONDS = 10_000;

let statsRequestCount = 0;
let realtime: FakeRealtime;

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: 'r1',
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    temperature: 23.8,
    humidity: 63,
    co2: 481,
    createdAt: '2026-09-10T22:39:46.000Z',
    ...overrides,
  };
}

function populatedStats(): ReadingStats {
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

function dayNight(overrides: Partial<DayNightStats> = {}): DayNightStats {
  return {
    // Oldest first, ending with the period still running.
    periods: [
      segment('day', false, populatedStats()),
      segment('night', false, emptyStats()),
      segment('day', true, populatedStats()),
    ],
    nextBoundary: '2026-09-11T01:30:00.000Z',
    daylight: {
      startTime: '06:30',
      endTime: '18:30',
      timezone: 'America/Vancouver',
    },
    ...overrides,
  };
}

function node(overrides: Partial<Node> = {}): Node {
  return {
    id: 'n1',
    slug: 'elantris',
    displayName: 'elantris',
    kind: 'rpi',
    status: NodeStatus.Admitted,
    online: true,
    availableUpdate: null,
    updates: NO_UPDATE_SUMMARY,
    ...overrides,
  } as unknown as Node;
}

function device(overrides: Partial<Device> = {}): Device {
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
    inputBtuPerHour: null,
    isOn: false,
    canTurnOn: true,
    canTurnOnAt: null,
    ...overrides,
  } as Device;
}

function renderNodeDetail(
  options: {
    stats?: DayNightStats;
    latest?: Reading[];
    live?: Record<string, Reading>;
    devices?: Device[];
    node?: Node;
    slug?: string;
    updateNode?: (id: string) => Observable<Node>;
  } = {},
): HTMLElement {
  statsRequestCount = 0;
  realtime = fakeRealtime({ readings: signal(options.live ?? {}) });
  // Some tests render twice, and TestBed refuses to be reconfigured once instantiated.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          nodes: () => of([options.node ?? node()]),
          latestReadings: () => of(options.latest ?? [reading()]),
          dayNightStats: () => {
            statsRequestCount++;
            return of(options.stats ?? dayNight());
          },
          devices: () => of(options.devices ?? []),
          updateNode: options.updateNode,
        },
      },
      {
        provide: RealtimeService,
        useValue: realtime,
      },
    ],
  });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('slug', options.slug ?? 'elantris');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function firstBlockRows(page: HTMLElement): HTMLElement[] {
  const block = page.querySelectorAll('tbody')[0];
  return [...block.querySelectorAll<HTMLElement>('tr:not(.metric)')];
}

function clickButton(page: HTMLElement, label: string): void {
  const button = [...page.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`No "${label}" button on the page`);
  button.click();
}

describe('NodeDetail', () => {
  it('sends a confirmed update for this node', async () => {
    const updateNode = vi.fn((nodeId: string) => of(node({ id: nodeId })));
    const page = renderNodeDetail({
      node: node({ availableUpdate: '1.1.1' }),
      updateNode,
    });

    clickButton(page, 'Update to 1.1.1');
    await TestBed.inject(ApplicationRef).whenStable();
    clickButton(page, 'Update to 1.1.1');

    expect(updateNode).toHaveBeenCalledWith('n1');
  });

  it('names itself in the top bar, with its kind and whether it is online', () => {
    renderNodeDetail({
      node: node({ displayName: 'Greenhouse Pi', online: false }),
    });
    expect(TestBed.inject(PageHeading).text()).toEqual({
      heading: 'Greenhouse Pi',
      subtitle: 'elantris · rpi · offline',
    });
  });

  it('shows the node going offline in the top bar without a reload', () => {
    renderNodeDetail({ node: node({ displayName: 'Greenhouse Pi' }) });
    pushNode(realtime, node({ displayName: 'Greenhouse Pi', online: false }));
    TestBed.tick();
    expect(TestBed.inject(PageHeading).text().subtitle).toBe(
      'elantris · rpi · offline',
    );
  });

  it('falls back to its slug in the top bar while the node is unknown', () => {
    renderNodeDetail({ slug: 'braize' });
    expect(TestBed.inject(PageHeading).text()).toEqual({
      heading: 'braize',
      subtitle: '',
    });
  });

  it('shows the current reading as gauges', () => {
    const page = renderNodeDetail();
    expect(page.querySelectorAll('temp-gauge')).toHaveLength(3);
    expect(page.textContent).toContain('23.8');
  });

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
    const page = renderNodeDetail({
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
    const names = [...page.querySelectorAll('.sensor__name')].map((name) =>
      name.textContent?.trim(),
    );
    expect(names).toEqual(['28-a', '28-b']);
    expect(page.querySelectorAll('temp-gauge')).toHaveLength(2);
    expect(page.querySelectorAll('tbody')).toHaveLength(1);
  });

  it('shows min, max and average for each metric', () => {
    const text = renderNodeDetail().textContent ?? '';
    for (const value of ['17.5', '23.8', '21.8', '54.9', '77.5', '584']) {
      expect(text).toContain(value);
    }
  });

  it('shows three alternating periods and no combined figure', () => {
    const page = renderNodeDetail();
    expect(firstBlockRows(page)).toHaveLength(3);
    expect(page.textContent).not.toContain('24 hours');
  });

  it('puts the running period at the top and marks it', () => {
    const rows = firstBlockRows(renderNodeDetail());
    expect(rows[0].classList.contains('running')).toBe(true);
    expect(rows[0].textContent).toContain('Day so far');
    expect(rows[2].classList.contains('running')).toBe(false);
  });

  it('says night so far when the running period is night', () => {
    const page = renderNodeDetail({
      stats: dayNight({
        periods: [
          segment('night', false, populatedStats()),
          segment('day', false, populatedStats()),
          segment('night', true, populatedStats()),
        ],
      }),
    });
    expect(page.querySelector('tr.running')?.textContent).toContain(
      'Night so far',
    );
  });

  it('does not claim a completed period is "last night"', () => {
    expect(renderNodeDetail().textContent).not.toContain('Last night');
  });

  it('shows when an extreme happened, not just what it was', () => {
    expect(renderNodeDetail().querySelectorAll('.at').length).toBeGreaterThan(
      0,
    );
  });

  it('renders an empty period as em-dashes, never zeros', () => {
    const emptyNightBetweenTheDays = firstBlockRows(renderNodeDetail())[1];
    expect(emptyNightBetweenTheDays.textContent).toContain('—');
    expect(emptyNightBetweenTheDays.textContent).not.toMatch(/\b0\b/);
  });

  it('says which daylight boundary it split at', () => {
    const text = renderNodeDetail().textContent ?? '';
    expect(text).toContain('06:30');
    expect(text).toContain('America/Vancouver');
  });

  it('prefers a live reading over the fetched one', () => {
    const page = renderNodeDetail({
      live: { 'elantris/scd4x-0': reading({ temperature: 31.4 }) },
    });
    expect(page.textContent).toContain('31.4');
  });

  it('says so plainly when the node has never reported', () => {
    expect(renderNodeDetail({ latest: [] }).textContent).toContain(
      'No readings from this node',
    );
  });

  it('says so plainly when there are no periods to show', () => {
    const page = renderNodeDetail({ stats: dayNight({ periods: [] }) });
    expect(page.textContent).toContain('No day or night period to show');
  });

  describe('keeping the figures current', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SCREEN_OPENED_AT);
    });
    afterEach(() => vi.useRealTimers());

    function pushReading(createdAt: string, nodeId = 'elantris'): void {
      realtime.readings.update((readings) => ({
        ...readings,
        [`${nodeId}/scd4x-0`]: reading({ nodeId, createdAt }),
      }));
      TestBed.tick();
    }

    function waitOutThrottle(): void {
      vi.advanceTimersByTime(STATS_REFRESH_THROTTLE_MILLISECONDS);
    }

    it('re-queries once for a burst of new readings, a minute after the first', () => {
      renderNodeDetail();
      expect(statsRequestCount).toBe(1);
      pushReading('2026-09-10T22:40:00.000Z');
      vi.advanceTimersByTime(TEN_SECONDS_MILLISECONDS);
      pushReading('2026-09-10T22:40:10.000Z');
      expect(statsRequestCount).toBe(1);
      waitOutThrottle();
      expect(statsRequestCount).toBe(2);
    });

    it('does not re-query for the readings it opened with', () => {
      renderNodeDetail();
      waitOutThrottle();
      waitOutThrottle();
      expect(statsRequestCount).toBe(1);
    });

    it('re-queries for a new reading even when the browser clock runs ahead of the server', () => {
      vi.setSystemTime(
        SCREEN_OPENED_AT.getTime() + BROWSER_CLOCK_AHEAD_MILLISECONDS,
      );
      renderNodeDetail();
      pushReading('2026-09-10T22:40:00.000Z');
      waitOutThrottle();
      expect(statsRequestCount).toBe(2);
    });

    it('ignores new readings from other nodes', () => {
      renderNodeDetail();
      pushReading('2026-09-10T22:40:00.000Z', 'braize');
      waitOutThrottle();
      expect(statsRequestCount).toBe(1);
    });

    it('re-queries when the period boundary passes', () => {
      vi.setSystemTime(new Date('2026-09-11T01:29:00.000Z'));
      renderNodeDetail();
      expect(statsRequestCount).toBe(1);
      vi.advanceTimersByTime(PAST_BOUNDARY_AND_SLACK_MILLISECONDS);
      expect(statsRequestCount).toBeGreaterThanOrEqual(2);
    });

    // Counts timers, not requests: the subscription is torn down separately, so requests miss a leaked interval.
    it('clears its timers once the screen is gone', () => {
      // Before the fixture's boundary; on the real clock it is past and no timeout is armed.
      vi.setSystemTime(new Date('2026-09-10T23:00:00.000Z'));
      renderNodeDetail();
      pushReading('2026-09-10T23:00:10.000Z');
      expect(vi.getTimerCount()).toBe(THROTTLE_WINDOW_AND_BOUNDARY_TIMEOUT);
      TestBed.resetTestingModule();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('NodeDetail relays', () => {
  it('lists the relays on this node with their pin and role', () => {
    const text = renderNodeDetail({ devices: [device()] }).textContent ?? '';
    expect(text).toContain('CO2 Generator');
    expect(text).toContain('BCM 5');
    expect(text).toContain('co2_generator');
  });

  it('states an energised relay in words', () => {
    const page = renderNodeDetail({ devices: [device({ isOn: true })] });
    expect(page.querySelector('.relay__state')?.textContent?.trim()).toBe('ON');
    expect(page.querySelector('.relay--on')).not.toBeNull();
  });

  it('says whether anything is driving it', () => {
    expect(renderNodeDetail({ devices: [device()] }).textContent).toContain(
      'automatic',
    );
    expect(
      renderNodeDetail({ devices: [device({ rulesEnabled: false })] })
        .textContent,
    ).toContain('manual');
  });

  it('shows the minimum-off hold when one is in force', () => {
    const page = renderNodeDetail({
      devices: [
        device({
          isOn: false,
          canTurnOn: false,
          canTurnOnAt: '2026-09-10T22:05:00.000Z',
        }),
      ],
    });
    expect(page.textContent).toContain('held off until');
    expect(page.textContent).toContain('300s minimum off');
  });

  it('does not claim a hold when the device is free to turn on', () => {
    expect(renderNodeDetail({ devices: [device()] }).textContent).not.toContain(
      'held off until',
    );
  });

  it('only lists relays belonging to this node', () => {
    const page = renderNodeDetail({
      devices: [
        device({ id: 'other', nodeId: 'elsewhere', name: 'Other Relay' }),
      ],
    });
    expect(page.textContent).not.toContain('Other Relay');
  });

  it('shows no relay card at all when the node has none', () => {
    expect(renderNodeDetail().querySelector('.relays')).toBeNull();
  });
});
