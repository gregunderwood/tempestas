import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import {
  DeviceRole,
  type RulesCycle,
  type SystemStatus,
  type Zone,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { FOLLOWER_NOTICE } from '../../shared/leadership';
import {
  fakeRealtime,
  pushDevice,
  type FakeRealtime,
} from '../../testing/fake-realtime';
import { ZonesPage } from './zones-page';
import {
  NOW,
  PUMPHOUSE,
  PUMPHOUSE_REFUSED,
  cycleOf,
  device,
  heatTape,
  node,
  probe,
  pumphouseEvaluation,
} from './zone-fixtures';

interface RenderedPage {
  page: HTMLElement;
  realtime: FakeRealtime;
  render(): void;
}

interface RenderOptions {
  zones?: Zone[];
  firstCycle?: RulesCycle | null;
  failingRequests?: ApiRequest[];
  pendingRequests?: ApiRequest[];
  browserClockAheadSeconds?: number;
}

type ApiRequest =
  | 'fetchZones'
  | 'nodes'
  | 'devices'
  | 'latestReadings'
  | 'fetchLatestRulesCycle';

function respondTo<Body>(
  request: ApiRequest,
  options: RenderOptions,
  body: Body,
): Observable<Body> {
  if (options.failingRequests?.includes(request)) {
    return throwError(() => new Error('offline'));
  }
  if (options.pendingRequests?.includes(request)) return NEVER;
  return of(body);
}

function renderZonesPage(options: RenderOptions = {}): RenderedPage {
  const browserClockAheadMilliseconds =
    (options.browserClockAheadSeconds ?? 0) * 1_000;
  vi.setSystemTime(NOW.getTime() + browserClockAheadMilliseconds);
  const realtime = fakeRealtime();
  realtime.serverClockOffsetMilliseconds.set(-browserClockAheadMilliseconds);
  const firstCycle =
    options.firstCycle === undefined
      ? cycleOf([pumphouseEvaluation()])
      : options.firstCycle;
  TestBed.configureTestingModule({
    imports: [ZonesPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          fetchZones: () =>
            respondTo('fetchZones', options, options.zones ?? [PUMPHOUSE]),
          nodes: () => respondTo('nodes', options, [node('patji', 'z-pump')]),
          fetchLatestRulesCycle: () =>
            respondTo('fetchLatestRulesCycle', options, firstCycle),
          latestReadings: () =>
            respondTo('latestReadings', options, [
              probe('pipes', 17.5),
              probe('air', 19.4),
            ]),
          devices: () => respondTo('devices', options, [device(), heatTape()]),
        },
      },
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const fixture = TestBed.createComponent(ZonesPage);
  const render = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  render();
  return { page: fixture.nativeElement as HTMLElement, realtime, render };
}

function probeLabelsOf(page: HTMLElement): string[] {
  return [...page.querySelectorAll('.probe__name')].map(
    (label) => label.textContent?.trim() ?? '',
  );
}

function statusWhile(isLeading: boolean): SystemStatus {
  return {
    at: NOW.toISOString(),
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 1,
    nodesTotal: 1,
    nodesPending: 0,
    isLeading,
    lastEvaluationAt: null,
    sentAt: NOW.toISOString(),
  };
}

function zoneSubtitleText(page: HTMLElement): string {
  return (
    page.querySelector('.zone mat-card-subtitle')?.textContent ?? ''
  ).replace(/\s+/g, ' ');
}

function countFollowerNotices(page: HTMLElement): number {
  return (page.textContent ?? '').split(FOLLOWER_NOTICE).length - 1;
}

function alertText(page: HTMLElement): string | undefined {
  return page.querySelector('[role="alert"]')?.textContent ?? undefined;
}

describe('ZonesPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a zone with its rules, probes and devices from first paint', () => {
    const { page } = renderZonesPage();
    expect(page.textContent).toContain('Pumphouse');
    expect(page.textContent).toContain('Controls on the coldest probe');
    expect(page.textContent).toContain('OFF · above setpoint');
    expect(page.querySelectorAll('.bar__track')).toHaveLength(2);
    expect(page.querySelector('.probe--controlling')?.textContent).toContain(
      'pipes',
    );
    expect(page.textContent).toContain('Read-only');
  });

  it('follows each rules cycle pushed over the socket', () => {
    const { page, realtime, render } = renderZonesPage();
    const coldEvaluation = pumphouseEvaluation();
    coldEvaluation.decisions[0] = {
      ...coldEvaluation.decisions[0],
      desired: 'on',
      reason: 'temp-below-setpoint',
    };
    realtime.latestRulesCycle.set(cycleOf([coldEvaluation]));
    render();
    expect(page.textContent).toContain('ON · below setpoint');
  });

  it('puts a zone the rules engine refused on its card', () => {
    const { page, realtime, render } = renderZonesPage();
    realtime.latestRulesCycle.set(PUMPHOUSE_REFUSED);
    render();
    expect(alertText(page)).toContain('invalid rules_config');
  });

  it('keeps every pushed device state, not only the newest', () => {
    const { page, realtime, render } = renderZonesPage();
    vi.advanceTimersByTime(1);
    pushDevice(realtime, device({ isOn: true }));
    render();
    pushDevice(realtime, heatTape({ isOn: true }));
    render();
    expect(page.querySelectorAll('.device--on')).toHaveLength(2);
  });

  it('shows a failing zone from first paint, before any socket message', () => {
    const { page } = renderZonesPage({ firstCycle: PUMPHOUSE_REFUSED });
    expect(alertText(page)).toContain('invalid rules_config');
    expect(page.textContent).not.toContain('OFF · above setpoint');
  });

  it('keeps rendering the other zones when one config cannot be drawn', () => {
    const brokenZone = {
      ...PUMPHOUSE,
      id: 'z-broken',
      slug: 'broken',
      displayName: 'Broken',
      rulesConfig: null,
    } as unknown as Zone;
    const { page } = renderZonesPage({ zones: [brokenZone, PUMPHOUSE] });
    expect(page.textContent).toContain('Broken');
    expect(page.textContent).toContain("this zone's config cannot be drawn");
    expect(page.textContent).toContain('OFF · above setpoint');
  });

  it('says the rules have stopped once a minute passes with no new cycle', () => {
    const { page, render } = renderZonesPage();
    expect(alertText(page)).toBeUndefined();
    vi.advanceTimersByTime(61_000);
    render();
    expect(alertText(page)).toContain('Rules have not run for over a minute.');
  });

  it('does not say the rules have stopped when the browser clock runs ahead of the server', () => {
    const { page } = renderZonesPage({ browserClockAheadSeconds: 300 });
    expect(alertText(page)).toBeUndefined();
    expect(page.textContent).toContain('rules ran 3 s ago');
  });

  it('still says the rules have stopped when the browser clock runs behind the server', () => {
    const { page, render } = renderZonesPage({
      browserClockAheadSeconds: -300,
    });
    expect(page.textContent).toContain('rules ran 3 s ago');
    vi.advanceTimersByTime(61_000);
    render();
    expect(alertText(page)).toContain('Rules have not run for over a minute.');
  });

  it('says a follower is following rather than that the rules have stopped', () => {
    const { page, realtime, render } = renderZonesPage();
    realtime.status.set(statusWhile(false));
    vi.advanceTimersByTime(61_000);
    render();
    expect(page.textContent).toContain(`${FOLLOWER_NOTICE}.`);
    expect(alertText(page)).toBeUndefined();
  });

  it('says a follower is following from first paint, with no cycle to show', () => {
    const { page, realtime, render } = renderZonesPage({ firstCycle: null });
    realtime.status.set(statusWhile(false));
    render();
    expect(page.textContent).toContain(`${FOLLOWER_NOTICE}.`);
    expect(alertText(page)).toBeUndefined();
  });

  it('keeps the stall alert on the leader and drops the follower notice once promoted', () => {
    const { page, realtime, render } = renderZonesPage();
    realtime.status.set(statusWhile(false));
    render();
    realtime.status.set(statusWhile(true));
    vi.advanceTimersByTime(61_000);
    render();
    expect(page.textContent).not.toContain(FOLLOWER_NOTICE);
    expect(alertText(page)).toContain('Rules have not run for over a minute.');
  });

  it("leaves the follower notice off a follower's zone card", () => {
    const { page, realtime, render } = renderZonesPage({ firstCycle: null });
    realtime.status.set(statusWhile(false));
    render();
    expect(zoneSubtitleText(page)).not.toContain(FOLLOWER_NOTICE);
    expect(zoneSubtitleText(page)).not.toContain('rules have not run yet');
    expect(zoneSubtitleText(page)).not.toContain('·');
  });

  it('says a follower is following exactly once, however many zones it shows', () => {
    const { page, realtime, render } = renderZonesPage({
      zones: [
        PUMPHOUSE,
        { ...PUMPHOUSE, id: 'z-cellar', slug: 'cellar', displayName: 'Cellar' },
      ],
    });
    realtime.status.set(statusWhile(false));
    render();
    expect(page.querySelectorAll('.zone')).toHaveLength(2);
    expect(countFollowerNotices(page)).toBe(1);
  });

  it("keeps how long ago the rules ran on the leader's zone card", () => {
    const { page, realtime, render } = renderZonesPage();
    realtime.status.set(statusWhile(true));
    render();
    expect(zoneSubtitleText(page)).toContain('· rules ran 3 s ago');
    expect(countFollowerNotices(page)).toBe(0);
  });

  it("says on the leader's zone card that rules have not run yet before the first cycle", () => {
    const { page, realtime, render } = renderZonesPage({ firstCycle: null });
    realtime.status.set(statusWhile(true));
    render();
    expect(zoneSubtitleText(page)).toContain('rules have not run yet');
    expect(zoneSubtitleText(page)).not.toContain(FOLLOWER_NOTICE);
  });

  it('ages the subtitle with the clock', () => {
    const { page, render } = renderZonesPage();
    expect(page.textContent).toContain('rules ran 3 s ago');
    vi.advanceTimersByTime(5_000);
    render();
    expect(page.textContent).toContain('rules ran 8 s ago');
  });

  it('says it could not load the zones rather than that there are none', () => {
    const { page } = renderZonesPage({ failingRequests: ['fetchZones'] });
    expect(page.textContent).toContain('Could not load the zones.');
    expect(page.textContent).not.toContain('No zones yet');
  });

  it('says which source failed rather than that a zone has no probes', () => {
    const { page } = renderZonesPage({ failingRequests: ['nodes'] });
    expect(page.textContent).toContain('Could not load the nodes.');
    expect(page.textContent).not.toContain('No probes reporting');
  });

  it('waits for every source rather than saying a role has no device', () => {
    const { page } = renderZonesPage({ pendingRequests: ['devices'] });
    expect(page.textContent).toContain('Loading zones…');
    expect(page.textContent).not.toContain('No device has this role');
  });

  it('names every source that failed together', () => {
    const { page } = renderZonesPage({
      failingRequests: ['nodes', 'latestReadings', 'fetchLatestRulesCycle'],
    });
    expect(page.textContent).toContain(
      'Could not load the nodes, readings, rules cycle.',
    );
  });

  it('draws from a rules cycle pushed over the socket while its request hangs', () => {
    const { page, realtime, render } = renderZonesPage({
      pendingRequests: ['fetchLatestRulesCycle'],
    });
    expect(page.textContent).toContain('Loading zones…');
    realtime.latestRulesCycle.set(cycleOf([pumphouseEvaluation()]));
    render();
    expect(page.textContent).toContain('OFF · above setpoint');
    expect(probeLabelsOf(page)).toEqual(['air', 'pipes']);
  });

  it('waits for the readings request even when some readings were pushed', () => {
    const { page, realtime, render } = renderZonesPage({
      pendingRequests: ['latestReadings'],
    });
    realtime.readings.set({ 'patji/pipes': probe('pipes', 17.5) });
    render();
    expect(page.textContent).toContain('Loading zones…');
    expect(page.textContent).not.toContain('No probes reporting');
  });

  it('does not call a pushed rules cycle out of date when its request failed', () => {
    const { page, realtime, render } = renderZonesPage({
      failingRequests: ['fetchLatestRulesCycle'],
    });
    realtime.latestRulesCycle.set(cycleOf([pumphouseEvaluation()]));
    render();
    expect(page.textContent).not.toContain('rules cycle');
    expect(page.textContent).toContain('OFF · above setpoint');
  });

  it('dims a stale reading that is off the scale', () => {
    const { page } = renderZonesPage({
      firstCycle: cycleOf([
        pumphouseEvaluation({ staleRoles: [DeviceRole.HeatTape] }),
      ]),
    });
    expect(page.querySelectorAll('.bar__offscale--stale')).toHaveLength(1);
  });

  it('recovers from a failed request when the socket reconnects', () => {
    const options: RenderOptions = { failingRequests: ['devices'] };
    const { page, realtime, render } = renderZonesPage(options);
    expect(page.textContent).toContain('Could not load the devices.');
    options.failingRequests = [];
    realtime.reconnectCount.update((count) => count + 1);
    render();
    expect(page.textContent).not.toContain('Could not load');
    expect(page.querySelectorAll('.device')).toHaveLength(2);
  });

  it('keeps showing devices but says so when refreshing them fails', () => {
    const options: RenderOptions = {};
    const { page, realtime, render } = renderZonesPage(options);
    options.failingRequests = ['devices'];
    realtime.reconnectCount.update((count) => count + 1);
    render();
    expect(page.textContent).toContain(
      'Could not refresh the devices; what follows may be out of date.',
    );
    expect(page.querySelectorAll('.device')).toHaveLength(2);
  });

  it('names each zone in a heading above its rules', () => {
    const { page } = renderZonesPage();
    expect(page.querySelector('h2')?.textContent).toContain('Pumphouse');
    expect(
      [...page.querySelectorAll('h3')].map((heading) => heading.textContent),
    ).toEqual(['Heater', 'Heat tape']);
  });
});
