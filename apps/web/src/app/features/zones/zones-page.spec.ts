import { TestBed } from '@angular/core/testing';
import {
  provideZonelessChangeDetection,
  signal,
  type WritableSignal,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import {
  DeviceRole,
  type Device,
  type RulesTick,
  type Zone,
} from '@tempestas/domain';
import type { PushedDevice } from '../../core/device-pushes';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { ZonesPage } from './zones-page';
import {
  NOW,
  PUMPHOUSE,
  device,
  node,
  probe,
  pumphouseEvaluation,
} from './zone-fixtures';

interface Live {
  rulesTick: WritableSignal<RulesTick | null>;
  devicePushes: WritableSignal<ReadonlyMap<string, PushedDevice>>;
}

function push(live: Live, device: Device): void {
  live.devicePushes.update((all) =>
    new Map(all).set(device.id, { device, receivedAt: Date.now() }),
  );
}

function setup(opts: { zones?: Zone[]; firstTick?: RulesTick | null } = {}): {
  el: HTMLElement;
  live: Live;
  render: () => void;
} {
  vi.setSystemTime(NOW);
  const live: Live = {
    rulesTick: signal(null),
    devicePushes: signal(new Map()),
  };
  const firstTick =
    opts.firstTick === undefined
      ? {
          at: NOW.toISOString(),
          evaluations: [pumphouseEvaluation()],
          failingZones: [],
        }
      : opts.firstTick;
  TestBed.configureTestingModule({
    imports: [ZonesPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          zones: () => of(opts.zones ?? [PUMPHOUSE]),
          nodes: () => of([node('patji', 'z-pump')]),
          rulesTick: () => of(firstTick),
          latestReadings: () => of([probe('pipes', 17.5), probe('air', 19.4)]),
          devices: () =>
            of([
              device(),
              device({
                id: 'd-tape',
                name: 'Heat tape',
                gpio: 6,
                role: DeviceRole.HeatTape,
              }),
            ]),
        },
      },
      {
        provide: RealtimeService,
        useValue: {
          readings: signal({}),
          status: signal(null),
          connected: signal(true),
          ...live,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ZonesPage);
  const render = () => {
    TestBed.tick();
    fixture.detectChanges();
  };
  render();
  return { el: fixture.nativeElement as HTMLElement, live, render };
}

describe('ZonesPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders a zone with its rules, probes and devices from first paint', () => {
    const { el } = setup();
    expect(el.textContent).toContain('Pumphouse');
    expect(el.textContent).toContain('Controls on the coldest probe');
    expect(el.textContent).toContain('OFF · above setpoint');
    expect(el.querySelectorAll('.bar__track')).toHaveLength(2);
    expect(el.querySelector('.probe--picked')?.textContent).toContain('pipes');
    expect(el.textContent).toContain('Read-only');
  });

  // After first paint the page lives on the socket: a new cycle replaces the
  // decision with no request of its own.
  it('follows each rules cycle pushed over the socket', () => {
    const { el, live, render } = setup();
    const cold = pumphouseEvaluation();
    cold.decisions[0] = {
      ...cold.decisions[0],
      desired: 'on',
      reason: 'temp-below-setpoint',
    };
    live.rulesTick.set({
      at: NOW.toISOString(),
      evaluations: [cold],
      failingZones: [],
    });
    render();
    expect(el.textContent).toContain('ON · below setpoint');
  });

  it('puts a zone the rules engine refused on its card', () => {
    const { el, live, render } = setup();
    live.rulesTick.set({
      at: NOW.toISOString(),
      evaluations: [],
      failingZones: [{ zoneSlug: 'pumphouse', reason: 'invalid rules_config' }],
    });
    render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'invalid rules_config',
    );
  });

  // The dashboard keeps only the newest push, so a second device's update
  // reverts the first. Here every push is kept.
  it('keeps every pushed device state, not only the newest', () => {
    const { el, live, render } = setup();
    push(live, device({ isOn: true }));
    render();
    push(
      live,
      device({
        id: 'd-tape',
        name: 'Heat tape',
        gpio: 6,
        role: DeviceRole.HeatTape,
        isOn: true,
      }),
    );
    render();
    expect(el.querySelectorAll('.device--on')).toHaveLength(2);
  });

  // The page opened while the socket is still connecting: the first paint
  // must already carry a zone the engine refused, not its last good decision.
  it('shows a failing zone from first paint, before any socket message', () => {
    const { el } = setup({
      firstTick: {
        at: NOW.toISOString(),
        evaluations: [],
        failingZones: [
          { zoneSlug: 'pumphouse', reason: 'invalid rules_config' },
        ],
      },
    });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'invalid rules_config',
    );
    expect(el.textContent).not.toContain('OFF · above setpoint');
  });

  it('keeps rendering the other zones when one config cannot be drawn', () => {
    const broken = {
      ...PUMPHOUSE,
      id: 'z-broken',
      slug: 'broken',
      displayName: 'Broken',
      rulesConfig: null,
    } as unknown as Zone;
    const { el } = setup({ zones: [broken, PUMPHOUSE] });
    expect(el.textContent).toContain('Broken');
    expect(el.textContent).toContain("this zone's config cannot be drawn");
    expect(el.textContent).toContain('OFF · above setpoint');
  });
});
