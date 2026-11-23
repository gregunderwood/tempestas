import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Route } from '@angular/router';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of } from 'rxjs';
import { App } from './app';
import { ApiService } from './core/api.service';
import { RealtimeService } from './core/realtime.service';
import { PageHeading } from './core/page-heading';
import { fakeRealtime } from './testing/fake-realtime';
import type { SystemStatus } from '@tempestas/domain';

function statusOf(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    at: '2026-01-10T12:00:00.000Z',
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 2,
    nodesTotal: 2,
    nodesPending: 0,
    isLeading: true,
    lastEvaluationAt: '2026-01-10T12:00:00.000Z',
    sentAt: '2026-01-10T12:00:00.000Z',
    ...overrides,
  };
}

const ROUTES: Route[] = [
  {
    path: 'reports',
    data: { heading: 'Reports', subtitle: 'How the nights went' },
    children: [],
  },
  { path: 'zones', children: [] },
];

function renderShell(status: SystemStatus | null, isConnected = true) {
  const realtime = {
    ...fakeRealtime({
      connected: signal(isConnected),
      status: signal(status),
    }),
    connect: () => undefined,
  };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(ROUTES),
      { provide: RealtimeService, useValue: realtime },
      { provide: ApiService, useValue: { devices: () => of([]) } },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    menuButton: element.querySelector<HTMLButtonElement>('.temp-menu-button'),
    nav: element.querySelector<HTMLElement>('#temp-nav'),
    banner: () => element.querySelector<HTMLElement>('[role="alert"]'),
  };
}

async function navigateTo(fixture: { detectChanges(): void }, url: string) {
  await TestBed.inject(Router).navigateByUrl(url);
  fixture.detectChanges();
}

describe('App shell', () => {
  it('links every screen from the nav', () => {
    const { nav } = renderShell(statusOf());
    const labels = Array.from(nav?.querySelectorAll('a') ?? []).map((link) =>
      link.textContent?.trim(),
    );
    expect(labels).toEqual([
      'Dashboard',
      'Reports',
      'Zones',
      'Devices',
      'Nodes',
    ]);
  });

  it('marks the current screen for a screen reader', async () => {
    const { fixture, nav } = renderShell(statusOf());
    await navigateTo(fixture, '/reports');
    const current = nav?.querySelector('[aria-current="page"]');
    expect(current?.textContent).toContain('Reports');
  });

  it('titles the top bar from the route', async () => {
    const { fixture, element } = renderShell(statusOf());
    await navigateTo(fixture, '/reports');
    expect(element.querySelector('.temp-heading')?.textContent).toBe('Reports');
    expect(element.querySelector('.temp-subtitle')?.textContent).toBe(
      'How the nights went',
    );
  });

  it('lets a page name itself, until the next navigation', async () => {
    const { fixture, element } = renderShell(statusOf());
    await navigateTo(fixture, '/reports');
    TestBed.inject(PageHeading).showPage({
      heading: 'greenhouse',
      subtitle: 'linux node',
    });
    fixture.detectChanges();
    expect(element.querySelector('.temp-heading')?.textContent).toBe(
      'greenhouse',
    );

    await navigateTo(fixture, '/zones');
    expect(element.querySelector('.temp-heading')?.textContent).toBe(
      'tempestas',
    );
  });

  it('keeps a page name through a navigation that stays on the page', async () => {
    const { fixture, element } = renderShell(statusOf());
    await navigateTo(fixture, '/reports');
    TestBed.inject(PageHeading).showPage({
      heading: 'greenhouse',
      subtitle: 'linux node',
    });
    await navigateTo(fixture, '/reports?days=7');
    expect(element.querySelector('.temp-heading')?.textContent).toBe(
      'greenhouse',
    );
  });

  it('says so when the socket is down', () => {
    const { element } = renderShell(statusOf(), false);
    expect(element.textContent).toContain('offline');
  });
});

// Holding last state is only sound if this alarm is visible, so its absence is a safety defect.
describe('App shell stale-sensor banner', () => {
  const staleStatus = statusOf({
    sensorStale: true,
    staleRoles: ['co2_generator'] as never,
  });

  it('is raised when the server says sensors are stale', () => {
    const { banner } = renderShell(staleStatus);
    expect(banner()?.textContent).toContain('holding its last state');
    expect(banner()?.textContent).toContain('co2_generator');
  });

  it('is absent when nothing is stale', () => {
    expect(renderShell(statusOf()).banner()).toBeNull();
  });

  it('is absent before the first status has arrived', () => {
    expect(renderShell(null).banner()).toBeNull();
  });

  it('sits full width above the page, never inside the nav the narrow layout hides', () => {
    const { element, nav, banner } = renderShell(staleStatus);
    const content = element.querySelector('.temp-content');
    expect(banner()?.parentElement).toBe(content);
    expect(nav?.contains(banner())).toBe(false);
    expect(banner()?.nextElementSibling?.tagName).toBe('MAIN');
  });

  it('stays in place while the narrow layout has its menu open', () => {
    const { fixture, menuButton, nav, banner } = renderShell(staleStatus);
    menuButton?.click();
    fixture.detectChanges();
    expect(nav?.classList.contains('temp-rail-open')).toBe(true);
    expect(banner()?.parentElement?.classList).toContain('temp-content');
    expect(banner()?.nextElementSibling?.tagName).toBe('MAIN');
  });

  it('offers no way to dismiss it', () => {
    expect(
      renderShell(staleStatus).banner()?.querySelector('button'),
    ).toBeNull();
  });
});

// Below 64rem the nav is a drawer; a closed one must leave the tab order and not survive a navigation.
describe('App shell menu', () => {
  it('starts closed and says so to a screen reader', () => {
    const { menuButton, nav } = renderShell(statusOf());
    expect(menuButton?.getAttribute('aria-expanded')).toBe('false');
    expect(nav?.classList.contains('temp-rail-open')).toBe(false);
  });

  it('opens and closes on the button', () => {
    const { fixture, menuButton, nav } = renderShell(statusOf());
    menuButton?.click();
    fixture.detectChanges();
    expect(menuButton?.getAttribute('aria-expanded')).toBe('true');
    expect(nav?.classList.contains('temp-rail-open')).toBe(true);

    menuButton?.click();
    fixture.detectChanges();
    expect(menuButton?.getAttribute('aria-expanded')).toBe('false');
    expect(nav?.classList.contains('temp-rail-open')).toBe(false);
  });

  it('points the button at the nav it controls', () => {
    const { menuButton, nav } = renderShell(statusOf());
    expect(menuButton?.getAttribute('aria-controls')).toBe(nav?.id);
  });

  it('closes on Escape', () => {
    const { fixture, menuButton, nav } = renderShell(statusOf());
    menuButton?.click();
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(nav?.classList.contains('temp-rail-open')).toBe(false);
  });

  it('hands focus back to the menu button on Escape', () => {
    const { fixture, menuButton, nav } = renderShell(statusOf());
    menuButton?.click();
    fixture.detectChanges();
    nav?.querySelector<HTMLElement>('a')?.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(document.activeElement).toBe(menuButton);
  });

  it('closes on the scrim', () => {
    const { fixture, element, menuButton, nav } = renderShell(statusOf());
    menuButton?.click();
    fixture.detectChanges();
    element.querySelector<HTMLElement>('.temp-scrim')?.click();
    fixture.detectChanges();
    expect(nav?.classList.contains('temp-rail-open')).toBe(false);
  });

  it('closes when a navigation completes', async () => {
    const { fixture, menuButton, nav } = renderShell(statusOf());
    menuButton?.click();
    fixture.detectChanges();
    await navigateTo(fixture, '/reports');
    expect(nav?.classList.contains('temp-rail-open')).toBe(false);
    expect(menuButton?.getAttribute('aria-expanded')).toBe('false');
  });
});
