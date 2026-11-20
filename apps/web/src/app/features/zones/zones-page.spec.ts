import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import type { RulesCycle, Zone } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
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
  failingRequest?: 'fetchZones' | 'nodes';
  pendingRequest?: 'devices';
}

function respondTo<Body>(
  request: string,
  options: RenderOptions,
  body: Body,
): Observable<Body> {
  if (options.failingRequest === request) {
    return throwError(() => new Error('offline'));
  }
  if (options.pendingRequest === request) return NEVER;
  return of(body);
}

function renderZonesPage(options: RenderOptions = {}): RenderedPage {
  vi.setSystemTime(NOW);
  const realtime = fakeRealtime();
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
          fetchLatestRulesCycle: () => of(firstCycle),
          latestReadings: () => of([probe('pipes', 17.5), probe('air', 19.4)]),
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

  it('ages the subtitle with the clock', () => {
    const { page, render } = renderZonesPage();
    expect(page.textContent).toContain('rules ran 3 s ago');
    vi.advanceTimersByTime(5_000);
    render();
    expect(page.textContent).toContain('rules ran 8 s ago');
  });

  it('says it could not load the zones rather than that there are none', () => {
    const { page } = renderZonesPage({ failingRequest: 'fetchZones' });
    expect(page.textContent).toContain('Could not load the zones.');
    expect(page.textContent).not.toContain('No zones yet');
  });

  it('says which source failed rather than that a zone has no probes', () => {
    const { page } = renderZonesPage({ failingRequest: 'nodes' });
    expect(page.textContent).toContain('Could not load the nodes.');
    expect(page.textContent).not.toContain('No probes reporting');
  });

  it('waits for every source rather than saying a role has no device', () => {
    const { page } = renderZonesPage({ pendingRequest: 'devices' });
    expect(page.textContent).toContain('Loading zones…');
    expect(page.textContent).not.toContain('No device has this role');
  });

  it('names each zone in a heading above its rules', () => {
    const { page } = renderZonesPage();
    expect(page.querySelector('h2')?.textContent).toContain('Pumphouse');
    expect(
      [...page.querySelectorAll('h3')].map((heading) => heading.textContent),
    ).toEqual(['Heater', 'Heat tape']);
  });
});
