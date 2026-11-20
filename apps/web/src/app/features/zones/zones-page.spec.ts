import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
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
  cycleOf,
  device,
  heatTape,
  node,
  probe,
  pumphouseEvaluation,
} from './zone-fixtures';

const PUMPHOUSE_REFUSED = cycleOf(
  [],
  [{ zoneSlug: 'pumphouse', reason: 'invalid rules_config' }],
);

interface RenderedPage {
  page: HTMLElement;
  realtime: FakeRealtime;
  render(): void;
}

function renderZonesPage(
  options: { zones?: Zone[]; firstCycle?: RulesCycle | null } = {},
): RenderedPage {
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
          zones: () => of(options.zones ?? [PUMPHOUSE]),
          nodes: () => of([node('patji', 'z-pump')]),
          rulesCycle: () => of(firstCycle),
          latestReadings: () => of([probe('pipes', 17.5), probe('air', 19.4)]),
          devices: () => of([device(), heatTape()]),
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
    expect(page.querySelector('.probe--picked')?.textContent).toContain(
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
    realtime.rulesCycle.set(cycleOf([coldEvaluation]));
    render();
    expect(page.textContent).toContain('ON · below setpoint');
  });

  it('puts a zone the rules engine refused on its card', () => {
    const { page, realtime, render } = renderZonesPage();
    realtime.rulesCycle.set(PUMPHOUSE_REFUSED);
    render();
    expect(alertText(page)).toContain('invalid rules_config');
  });

  it('keeps every pushed device state, not only the newest', () => {
    const { page, realtime, render } = renderZonesPage();
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
});
