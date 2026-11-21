import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import {
  DeviceRole,
  NodeKind,
  NodeStatus,
  ReadingOrder,
  type DayNightStats,
  type Device,
  type MetricKey,
  type Node,
  type Reading,
  type ReadingsQuery,
  type RulesCycle,
  type SystemStatus,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  fakeRealtime,
  pushDevice,
  type FakeRealtime,
} from '../../testing/fake-realtime';
import {
  NOW,
  cycleOf,
  device,
  pumphouseEvaluation,
} from '../zones/zone-fixtures';
import { Dashboard } from './dashboard';
import { PERIOD_START_RETRY_MILLISECONDS } from './period-start';

const MINUTE_MILLISECONDS = 60_000;
const DAY_BEGAN = new Date(NOW.getTime() - 6 * 60 * MINUTE_MILLISECONDS);

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * MINUTE_MILLISECONDS).toISOString();
}

function reading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: 'r1',
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    temperature: 23.7,
    humidity: 62,
    co2: 861,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function probe(
  sensorId: string,
  temperature: number,
  overrides: Partial<Reading> = {},
): Reading {
  return reading({
    id: sensorId,
    nodeId: 'pumphouse',
    sensorId,
    temperature,
    humidity: null,
    co2: null,
    ...overrides,
  });
}

function node(slug: string, sensors: Record<string, MetricKey[]>): Node {
  return {
    id: slug,
    slug,
    displayName: slug,
    location: null,
    kind: NodeKind.RaspberryPi,
    status: NodeStatus.Admitted,
    online: true,
    lastSeenAt: null,
    agentName: null,
    agentVersion: null,
    contractStanding: 'current',
    capabilities: {
      contractVersion: 1,
      hasRtc: true,
      sensors: Object.entries(sensors).map(([sensorId, metrics]) => ({
        sensorId,
        kind: 'test',
        metrics,
        sampleIntervalMs: 30_000,
      })),
    },
    zoneId: null,
    deviceCount: 0,
    latestReadingAt: null,
  };
}

function statusOf(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    at: NOW.toISOString(),
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 2,
    nodesTotal: 3,
    nodesPending: 0,
    isLeading: true,
    lastEvaluationAt: NOW.toISOString(),
    sentAt: NOW.toISOString(),
    ...overrides,
  };
}

function dayStartingAt(from: Date): DayNightStats {
  return {
    periods: [
      {
        kind: 'day',
        from: from.toISOString(),
        to: NOW.toISOString(),
        inProgress: true,
        stats: {} as DayNightStats['periods'][number]['stats'],
      },
    ],
    nextBoundary: null,
    daylight: {
      startTime: '07:00',
      endTime: '17:00',
      timezone: 'America/Vancouver',
    },
  };
}

const ELANTRIS = node('elantris', {
  'scd4x-0': ['temperature', 'humidity', 'co2'],
});

interface DashboardSetup {
  readings?: Reading[];
  devices?: Device[];
  nodes?: Node[];
  pushed?: Device[];
  cycle?: RulesCycle | null;
  status?: SystemStatus | null;
  isConnected?: boolean;
  dayNight?: DayNightStats | null;
  periodStartReadings?: Reading[];
  periodStartResponses?: (Reading[] | 'fail')[];
  browserClockAheadSeconds?: number;
}

interface RenderedDashboard {
  fixture: ComponentFixture<Dashboard>;
  page: HTMLElement;
  realtime: FakeRealtime;
  readingsQueries: ReadingsQuery[];
  text(): string;
  refresh(): void;
}

function renderDashboard(options: DashboardSetup = {}): RenderedDashboard {
  const browserClockAheadMilliseconds =
    (options.browserClockAheadSeconds ?? 0) * 1_000;
  vi.setSystemTime(NOW.getTime() + browserClockAheadMilliseconds);
  const realtime = fakeRealtime();
  realtime.serverClockOffsetMilliseconds.set(-browserClockAheadMilliseconds);
  const readingsQueries: ReadingsQuery[] = [];
  realtime.status.set(
    options.status === undefined ? statusOf() : options.status,
  );
  realtime.connected.set(options.isConnected ?? true);
  for (const pushedDevice of options.pushed ?? []) {
    pushDevice(realtime, pushedDevice);
  }
  TestBed.configureTestingModule({
    imports: [Dashboard],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          latestReadings: () => of(options.readings ?? [reading()]),
          devices: () => of(options.devices ?? []),
          nodes: () => of(options.nodes ?? [ELANTRIS]),
          fetchLatestRulesCycle: () => of(options.cycle ?? null),
          dayNightStats: () =>
            of(
              options.dayNight ?? { ...dayStartingAt(DAY_BEGAN), periods: [] },
            ),
          readings: (query: ReadingsQuery) => {
            readingsQueries.push(query);
            const response =
              options.periodStartResponses?.shift() ??
              options.periodStartReadings ??
              [];
            return response === 'fail'
              ? throwError(() => new Error('unreachable'))
              : of(response);
          },
        },
      },
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const fixture = TestBed.createComponent(Dashboard);
  fixture.detectChanges();
  const page = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    page,
    realtime,
    readingsQueries,
    text: () => (page.textContent ?? '').replace(/\s+/g, ' '),
    refresh: () => {
      TestBed.tick();
      fixture.detectChanges();
    },
  };
}

function readAloud(domNode: globalThis.Node): string {
  if (domNode.nodeType === domNode.TEXT_NODE) {
    return domNode.textContent?.trim() ?? '';
  }
  if ((domNode as Element).getAttribute?.('aria-hidden') === 'true') return '';
  return [...domNode.childNodes]
    .map(readAloud)
    .filter((part) => part.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ');
}

function textsOf(page: HTMLElement, selector: string): string[] {
  return [...page.querySelectorAll(selector)].map(readAloud);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Dashboard hero', () => {
  it('says all is well when every zone decided normally', () => {
    const { page } = renderDashboard({
      cycle: cycleOf([pumphouseEvaluation()]),
    });
    expect(page.querySelector('.hero__state')?.textContent).toContain(
      'All zones running normally',
    );
  });

  it('shows a tile per zone and role, with its reading, decision and age', () => {
    const { page } = renderDashboard({
      cycle: cycleOf([pumphouseEvaluation()]),
    });
    expect(textsOf(page, '.tile')).toEqual([
      'pumphouse · Heater 17.5 °C OFF · above setpoint decided 3 s ago',
      'pumphouse · Heat tape 17.5 °C OFF · above setpoint decided 3 s ago',
    ]);
  });

  it('says when a decision never reached its relay', () => {
    const evaluation = pumphouseEvaluation();
    evaluation.decisions[0] = {
      ...evaluation.decisions[0],
      desired: 'on',
      reason: 'frost-protection',
      dispatched: [
        {
          deviceId: 'd-heater',
          deviceName: 'Heater',
          outcome: 'rules-disabled',
        },
      ],
    };
    const { page } = renderDashboard({ cycle: cycleOf([evaluation]) });
    expect(textsOf(page, '.tile__unapplied')).toEqual([
      'Not switched: automation off for this device',
    ]);
  });

  it('shows an em-dash in a tile whose reading is unknown', () => {
    const evaluation = pumphouseEvaluation({ climateByRole: {} });
    const { page } = renderDashboard({ cycle: cycleOf([evaluation]) });
    expect(textsOf(page, '.tile__reading')).toEqual(['—', '—']);
  });

  it('shows an em-dash for a CO₂ generator whose CO₂ is unknown', () => {
    const evaluation = pumphouseEvaluation({
      decisions: [
        {
          role: DeviceRole.Co2Generator,
          desired: 'noop',
          reason: 'no-sensor',
          sourceNodeIds: [],
          dispatched: [],
        },
      ],
    });
    evaluation.climateByRole.co2_generator = {
      temperatureC: 21,
      co2Ppm: null,
      observedAt: NOW.toISOString(),
      sourceNodeIds: ['elantris'],
      sourceSensorIds: ['elantris/scd4x-0'],
      decidingSensorIds: ['elantris/scd4x-0'],
    };
    const { page } = renderDashboard({ cycle: cycleOf([evaluation]) });
    expect(textsOf(page, '.tile__reading')).toEqual(['—']);
  });

  it('leaves out roles tempestas does not drive', () => {
    const evaluation = pumphouseEvaluation();
    evaluation.decisions[1] = {
      ...evaluation.decisions[1],
      reason: 'role-not-owned',
    };
    const { page } = renderDashboard({ cycle: cycleOf([evaluation]) });
    expect(page.querySelectorAll('.tile')).toHaveLength(1);
  });

  it('leads with the socket being down', () => {
    const { page } = renderDashboard({
      isConnected: false,
      cycle: cycleOf([pumphouseEvaluation()]),
    });
    expect(page.querySelector('.hero__state')?.textContent).toContain(
      'Offline',
    );
  });

  it('says when this server only follows', () => {
    const { page } = renderDashboard({
      status: statusOf({ isLeading: false }),
    });
    expect(page.querySelector('.hero__state')?.textContent).toContain(
      'another server runs the rules',
    );
  });

  it('names the zone whose sensors have gone quiet', () => {
    const evaluation = pumphouseEvaluation({
      staleRoles: [DeviceRole.Heater],
    });
    const { page } = renderDashboard({ cycle: cycleOf([evaluation]) });
    expect(page.querySelector('.hero__state')?.textContent).toContain(
      'Sensors quiet in pumphouse',
    );
  });

  it('shows an em-dash for nodes online before the first status', () => {
    const { page } = renderDashboard({ status: null });
    expect(page.querySelector('.hero__facts')?.textContent).toContain(
      '— nodes online',
    );
  });

  it('follows a rules cycle pushed over the socket', () => {
    const rendered = renderDashboard({ cycle: null });
    expect(rendered.page.querySelector('.hero__state')?.textContent).toContain(
      'Waiting for the first rules cycle',
    );

    rendered.realtime.latestRulesCycle.set(cycleOf([pumphouseEvaluation()]));
    rendered.refresh();
    expect(rendered.page.querySelectorAll('.tile')).toHaveLength(2);
    expect(rendered.text()).toContain('Rules ran 0 s ago');
  });
});

describe('Dashboard stat cards', () => {
  it('shows a card per node with a figure for each metric', () => {
    const { page } = renderDashboard();
    expect(textsOf(page, '.stat__value')).toEqual([
      '23.7 °C',
      '62.0 %',
      '861 PPM',
    ]);
  });

  // Zero reads as extremely low, which is the direction that runs the burner.
  it('shows an em-dash for an unknown CO₂, its trend and its range', () => {
    const { page } = renderDashboard({ readings: [reading({ co2: null })] });
    const stats = page.querySelectorAll('.stat');
    const co2 = stats[2];
    expect(co2.querySelector('.stat__value')?.textContent).toContain('—');
    expect(co2.querySelector('.stat__trend')?.textContent?.trim()).toBe('—');
    expect(co2.querySelector('.stat__range-unknown')?.textContent).toBe('—');
    expect(co2.querySelector('.stat__range')).toBeNull();
  });

  it('shows an em-dash trend until the period has a first reading', () => {
    const { page } = renderDashboard();
    expect(textsOf(page, '.stat__trend')).toEqual(['—', '—', '—']);
  });

  it('shows the change since the running period began', () => {
    const { page } = renderDashboard({
      dayNight: dayStartingAt(DAY_BEGAN),
      periodStartReadings: [
        reading({
          temperature: 21.0,
          humidity: 62,
          co2: 900,
          createdAt: minutesAgo(355),
        }),
        reading({
          temperature: 22.5,
          humidity: 70,
          co2: 1000,
          createdAt: minutesAgo(359),
        }),
      ],
    });
    expect(textsOf(page, '.stat__trend')).toEqual([
      '▲ +1.2 since the day began',
      '▼ −8.0 since the day began',
      '▼ −139 since the day began',
    ]);
  });

  it('fills in trends once the new period has its first reading', () => {
    const baseline = reading({ temperature: 22.5, createdAt: minutesAgo(1) });
    const rendered = renderDashboard({
      dayNight: dayStartingAt(new Date(NOW.getTime() - MINUTE_MILLISECONDS)),
      periodStartResponses: [[], [baseline]],
    });
    expect(textsOf(rendered.page, '.stat__trend')[0]).toBe('—');

    vi.advanceTimersByTime(PERIOD_START_RETRY_MILLISECONDS);
    rendered.refresh();
    expect(textsOf(rendered.page, '.stat__trend')[0]).toBe(
      '▲ +1.2 since the day began',
    );
  });

  it("asks for each sensor's first reading since the period began, however late it came", () => {
    const { readingsQueries } = renderDashboard({
      dayNight: dayStartingAt(DAY_BEGAN),
      readings: [probe('28-a', 3.1), probe('28-b', 4.2)],
      nodes: [
        node('pumphouse', { '28-a': ['temperature'], '28-b': ['temperature'] }),
      ],
    });
    const firstReadingQuery = (sensorId: string) => ({
      nodeId: 'pumphouse',
      sensorId,
      from: DAY_BEGAN.toISOString(),
      order: ReadingOrder.OldestFirst,
      limit: 1,
    });
    expect(readingsQueries).toEqual([
      firstReadingQuery('28-a'),
      firstReadingQuery('28-b'),
    ]);
  });

  it('gives a probe that comes back mid-period its own baseline', () => {
    const rendered = renderDashboard({
      dayNight: dayStartingAt(DAY_BEGAN),
      readings: [
        probe('28-a', 3.1),
        probe('28-b', 4.2, { createdAt: minutesAgo(400) }),
      ],
      nodes: [
        node('pumphouse', { '28-a': ['temperature'], '28-b': ['temperature'] }),
      ],
      periodStartReadings: [
        probe('28-a', 2.0, { createdAt: minutesAgo(350) }),
        probe('28-b', 4.0, { createdAt: minutesAgo(5) }),
      ],
    });
    expect(textsOf(rendered.page, '.stat__trend')).toEqual([
      '▲ +1.1 since the day began',
      '—',
    ]);

    rendered.realtime.readings.set({ 'pumphouse/28-b': probe('28-b', 4.2) });
    rendered.refresh();
    expect(textsOf(rendered.page, '.stat__trend')).toEqual([
      '▲ +1.1 since the day began',
      '▲ +0.2 since the day began',
    ]);
  });

  it('tries the trend baseline again after a failed request', () => {
    const baseline = reading({ temperature: 22.5, createdAt: minutesAgo(1) });
    const rendered = renderDashboard({
      dayNight: dayStartingAt(DAY_BEGAN),
      periodStartResponses: ['fail', [baseline]],
    });
    vi.advanceTimersByTime(PERIOD_START_RETRY_MILLISECONDS);
    rendered.refresh();
    expect(textsOf(rendered.page, '.stat__trend')[0]).toBe(
      '▲ +1.2 since the day began',
    );
  });

  it('places each figure within its range', () => {
    const { page } = renderDashboard({
      readings: [reading({ temperature: 25 })],
    });
    const fill = page.querySelector<HTMLElement>('.stat__range-fill');
    expect(fill?.style.width).toBe('50%');
  });

  it('says how long ago a fresh node read', () => {
    const { page } = renderDashboard({
      readings: [reading({ createdAt: minutesAgo(0.5) })],
    });
    expect(page.querySelector('.age')?.textContent).toContain('Read 30 s ago');
    expect(page.querySelector('.card--quiet')).toBeNull();
  });

  it('marks a card whose reading has stopped arriving', () => {
    const { page } = renderDashboard({
      readings: [reading({ createdAt: minutesAgo(10) })],
    });
    expect(page.querySelector('.age')?.textContent).toContain(
      'no reading for 10 min',
    );
    expect(page.querySelector('.card--quiet')).not.toBeNull();
  });

  it('names the probe that has stopped reporting', () => {
    const { text } = renderDashboard({
      readings: [
        probe('28-a', 3.1),
        probe('28-b', 4.2, { createdAt: minutesAgo(10) }),
      ],
      nodes: [
        node('pumphouse', { '28-a': ['temperature'], '28-b': ['temperature'] }),
      ],
    });
    expect(text()).toContain('28-b: no reading for 10 min');
    expect(text()).not.toContain('28-a: no reading');
  });

  it('ages decisions and readings by the server clock when the browser clock runs ahead', () => {
    const { page } = renderDashboard({
      cycle: cycleOf([pumphouseEvaluation()]),
      readings: [reading({ createdAt: minutesAgo(0.5) })],
      browserClockAheadSeconds: 300,
    });
    expect(page.querySelector('.tile')?.textContent).toContain(
      'decided 3 s ago',
    );
    expect(page.querySelector('.age')?.textContent).toContain('Read 30 s ago');
    expect(page.querySelector('.card--quiet')).toBeNull();
  });

  it('still marks a quiet reading when the browser clock runs behind the server', () => {
    const { page } = renderDashboard({
      readings: [reading({ createdAt: minutesAgo(10) })],
      browserClockAheadSeconds: -300,
    });
    expect(page.querySelector('.age')?.textContent).toContain(
      'no reading for 10 min',
    );
    expect(page.querySelector('.card--quiet')).not.toBeNull();
  });

  it('shows only the metrics each sensor declares, captioned by sensor', () => {
    const { page } = renderDashboard({
      readings: [probe('28-a', 3.1), probe('28-b', 4.2)],
      nodes: [
        node('pumphouse', { '28-a': ['temperature'], '28-b': ['temperature'] }),
      ],
    });
    expect(page.querySelectorAll('temp-node-stat-card')).toHaveLength(1);
    expect(textsOf(page, '.stat__sensor')).toEqual(['28-a', '28-b']);
  });

  it('does not caption the figures of a single-sensor node', () => {
    expect(renderDashboard().page.querySelector('.stat__sensor')).toBeNull();
  });

  // Colour alone is not readable in sunlight, and this one means a burner is alight.
  it('states an energised relay in words', () => {
    const { page } = renderDashboard({
      readings: [reading()],
      devices: [
        device({ nodeId: 'elantris', isOn: true, onAt: NOW.toISOString() }),
      ],
    });
    expect(textsOf(page, '.relay__state')[0]).toMatch(/^ON since \d\d:\d\d$/);
  });

  it('shows an idle relay as off', () => {
    const { page } = renderDashboard({
      devices: [device({ nodeId: 'elantris' })],
    });
    expect(page.querySelector('.relay__state')?.textContent?.trim()).toBe(
      'off',
    );
  });

  it('only lists relays belonging to that node', () => {
    const { text } = renderDashboard({
      devices: [device({ name: 'Other Relay' })],
    });
    expect(text()).not.toContain('Other Relay');
  });

  function relayStateOnSince(onAt: string): string {
    const { page } = renderDashboard({
      devices: [device({ nodeId: 'elantris', isOn: true, onAt })],
    });
    return page.querySelector('.relay__state')?.textContent ?? '';
  }

  it('dates a relay that has been on since an earlier day', () => {
    const yesterday = minutesAgo(24 * 60);
    const dayOfMonth = new Date(yesterday).getDate();
    expect(relayStateOnSince(yesterday)).toMatch(
      new RegExp(`since [A-Z][a-z]{2} ${dayOfMonth}, \\d\\d:\\d\\d`),
    );
  });

  it('gives only the time for a relay that switched on today', () => {
    expect(relayStateOnSince(minutesAgo(1))).toMatch(/since \d\d:\d\d\s*$/);
  });

  it('keeps every pushed device state, not only the newest', () => {
    const heater = device({ id: 'd1', nodeId: 'elantris' });
    const tape = device({ id: 'd2', nodeId: 'elantris', name: 'Heat tape' });
    const { page } = renderDashboard({
      devices: [heater, tape],
      pushed: [
        { ...heater, isOn: true },
        { ...tape, isOn: true },
      ],
    });
    expect(page.querySelectorAll('.relay--on')).toHaveLength(2);
  });

  it('follows a reading pushed over the socket', () => {
    const rendered = renderDashboard();
    rendered.realtime.readings.set({
      'elantris/scd4x-0': reading({ temperature: 30.1 }),
    });
    rendered.refresh();
    expect(textsOf(rendered.page, '.stat__value')[0]).toBe('30.1 °C');
  });

  it('says so plainly when there is nothing to show', () => {
    expect(renderDashboard({ readings: [] }).text()).toContain(
      'No readings yet',
    );
  });
});

describe('Dashboard attention panel', () => {
  function attentionOf(rendered: RenderedDashboard): string[] {
    return textsOf(rendered.page, 'temp-attention-panel li');
  }

  it('says nothing needs you when all is well', () => {
    expect(renderDashboard().text()).toContain('Nothing needs you.');
  });

  it('lists nodes waiting to be admitted, linked to the nodes page', () => {
    const rendered = renderDashboard({ status: statusOf({ nodesPending: 2 }) });
    expect(attentionOf(rendered)).toEqual([
      '2 nodes are waiting to be admitted.',
    ]);
    expect(
      rendered.page
        .querySelector('temp-attention-panel a')
        ?.getAttribute('href'),
    ).toBe('/nodes');
  });

  it('lists a follower that is not leading', () => {
    const rendered = renderDashboard({
      status: statusOf({ isLeading: false }),
    });
    expect(attentionOf(rendered)[0]).toContain('follower');
  });

  it('lists a probe that has gone quiet', () => {
    const rendered = renderDashboard({
      readings: [probe('28-a', 3.1, { createdAt: minutesAgo(5) })],
    });
    expect(attentionOf(rendered)).toEqual([
      'pumphouse 28-a: no reading for 5 min.',
    ]);
  });

  it('lists a zone whose rules failed, and a decision that warns', () => {
    const warning = pumphouseEvaluation();
    warning.decisions[0] = { ...warning.decisions[0], reason: 'sensor-stale' };
    const rendered = renderDashboard({
      cycle: cycleOf(
        [warning],
        [{ zoneSlug: 'cellar', reason: 'no zone row' }],
      ),
    });
    expect(attentionOf(rendered)).toEqual([
      'cellar: rules failed, no zone row.',
      'pumphouse Heater: sensors stale, holding last state.',
    ]);
  });

  it('follows a status pushed over the socket', () => {
    const rendered = renderDashboard();
    rendered.realtime.status.set(statusOf({ nodesPending: 1 }));
    rendered.refresh();
    expect(attentionOf(rendered)).toEqual([
      '1 node is waiting to be admitted.',
    ]);
  });
});

describe('Dashboard activity panel', () => {
  function activityOf(rendered: RenderedDashboard): string[] {
    return textsOf(rendered.page, 'temp-activity-panel li');
  }

  function clockTime(isoTime: string): string {
    return new Date(isoTime).toLocaleTimeString('en-GB', { hour12: false });
  }

  it('says nothing has changed yet', () => {
    expect(renderDashboard().text()).toContain(
      'Nothing has changed since the app opened.',
    );
  });

  it('records a relay switch pushed over the socket, with its clock time', () => {
    const heater = device({ nodeId: 'elantris' });
    const rendered = renderDashboard({ devices: [heater], pushed: [heater] });
    const switchedAt = NOW.toISOString();
    pushDevice(rendered.realtime, { ...heater, isOn: true, onAt: switchedAt });
    rendered.refresh();
    expect(activityOf(rendered)).toEqual([
      `${clockTime(switchedAt)} Relay Heater switched ON`,
    ]);
  });

  it('records a decision that changed between two cycles, newest first', () => {
    const rendered = renderDashboard();
    rendered.realtime.latestRulesCycle.set(cycleOf([pumphouseEvaluation()]));
    rendered.refresh();

    const heating = pumphouseEvaluation();
    heating.decisions[0] = {
      ...heating.decisions[0],
      desired: 'on',
      reason: 'temp-below-setpoint',
    };
    rendered.realtime.latestRulesCycle.set({
      ...cycleOf([heating]),
      at: minutesAgo(-1),
    });
    rendered.refresh();

    const heaterOff = device({ nodeId: 'elantris' });
    pushDevice(rendered.realtime, heaterOff);
    pushDevice(rendered.realtime, {
      ...heaterOff,
      isOn: true,
      onAt: minutesAgo(-2),
    });
    rendered.refresh();

    expect(activityOf(rendered)).toEqual([
      `${clockTime(minutesAgo(-2))} Relay Heater switched ON`,
      `${clockTime(heating.evaluatedAt)} Rules pumphouse Heater: ON · below setpoint`,
    ]);
  });

  it('shows when the rules last ran', () => {
    const cycle = cycleOf([pumphouseEvaluation()]);
    const { text } = renderDashboard({ cycle });
    expect(text()).toContain(`Rules last ran at ${clockTime(cycle.at)}`);
  });
});
