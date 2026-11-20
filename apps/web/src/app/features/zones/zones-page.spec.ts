import { TestBed } from '@angular/core/testing';
import {
  provideZonelessChangeDetection,
  signal,
  type WritableSignal,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DeviceRole, type Device, type RulesTick } from '@tempestas/domain';
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
  deviceState: WritableSignal<Device | null>;
}

function setup(): { el: HTMLElement; live: Live; render: () => void } {
  vi.setSystemTime(NOW);
  const live: Live = { rulesTick: signal(null), deviceState: signal(null) };
  TestBed.configureTestingModule({
    imports: [ZonesPage],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          zones: () => of([PUMPHOUSE]),
          nodes: () => of([node('patji', 'z-pump')]),
          lastEvaluation: () => of([pumphouseEvaluation()]),
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
    live.deviceState.set(device({ isOn: true }));
    render();
    live.deviceState.set(
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
});
