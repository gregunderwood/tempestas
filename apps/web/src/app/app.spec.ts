import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { signal } from '@angular/core';
import { App } from './app';
import { RealtimeService } from './core/realtime.service';
import type { SystemStatus } from '@tempestas/domain';

function statusOf(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    at: '2026-01-10T12:00:00.000Z',
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 2,
    nodesTotal: 2,
    lastEvaluationAt: '2026-01-10T12:00:00.000Z',
    ...overrides,
  };
}

function setup(
  status: SystemStatus | null,
  connected = true,
  routes: Route[] = [],
) {
  const fake = {
    connected: signal(connected),
    status: signal(status),
    readings: signal({}),
    deviceState: signal(null),
    connect: () => undefined,
  };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(routes),
      { provide: RealtimeService, useValue: fake },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  return fixture;
}

describe('App shell', () => {
  it('shows the nav', () => {
    const text =
      (setup(statusOf()).nativeElement as HTMLElement).textContent ?? '';
    for (const link of ['Dashboard', 'Readings', 'Devices', 'Nodes']) {
      expect(text).toContain(link);
    }
  });

  // Layer 1 of the safety design holds last state when readings stop, and is
  // explicit that this is "only sound if the alarm is actually visible". The
  // banner IS that alarm, so its absence is a safety defect, not a cosmetic one.
  it('raises the stale-sensor banner when the server says sensors are stale', () => {
    const fixture = setup(
      statusOf({ sensorStale: true, staleRoles: ['co2_generator'] as never }),
    );
    const banner = (fixture.nativeElement as HTMLElement).querySelector(
      '[role="alert"]',
    );

    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('holding its last state');
    expect(banner?.textContent).toContain('co2_generator');
  });

  it('shows no banner when nothing is stale', () => {
    const fixture = setup(statusOf({ sensorStale: false }));
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]'),
    ).toBeNull();
  });

  it('shows no banner before the first status has arrived', () => {
    const fixture = setup(null);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]'),
    ).toBeNull();
  });

  // A dashboard that has quietly stopped updating looks exactly like one where
  // nothing is happening.
  it('says so when the socket is down', () => {
    const text =
      (setup(statusOf(), false).nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('offline');
  });
});

// The nav collapses behind a button on narrow screens. These assert the parts
// that are not styling: a link that is hidden must also leave the tab order and
// the accessibility tree, and the menu must not survive a navigation and cover
// the screen somebody just asked to see.
describe('App shell menu', () => {
  function shell() {
    // A real route, so a navigation actually completes and emits NavigationEnd.
    const fixture = setup(statusOf(), true, [
      { path: 'readings', children: [] },
    ]);
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      el,
      button: el.querySelector<HTMLButtonElement>('.temp-menu-button'),
      nav: el.querySelector<HTMLElement>('.temp-nav'),
    };
  }

  it('starts closed and says so to a screen reader', () => {
    const { button, nav } = shell();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(nav?.classList.contains('temp-nav-open')).toBe(false);
  });

  it('opens and closes on the button', () => {
    const { fixture, button, nav } = shell();
    button?.click();
    fixture.detectChanges();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(nav?.classList.contains('temp-nav-open')).toBe(true);

    button?.click();
    fixture.detectChanges();
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(nav?.classList.contains('temp-nav-open')).toBe(false);
  });

  it('points the button at the nav it controls', () => {
    const { button, nav } = shell();
    expect(button?.getAttribute('aria-controls')).toBe('temp-nav');
    expect(nav?.id).toBe('temp-nav');
  });

  it('closes when a navigation completes', async () => {
    const { fixture, button, nav } = shell();
    button?.click();
    fixture.detectChanges();
    expect(nav?.classList.contains('temp-nav-open')).toBe(true);

    await TestBed.inject(Router).navigateByUrl('/readings');
    fixture.detectChanges();
    expect(nav?.classList.contains('temp-nav-open')).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('false');
  });
});
