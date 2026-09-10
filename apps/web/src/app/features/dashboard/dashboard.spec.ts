import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { Device, Reading } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { Dashboard } from './dashboard';

const NOW = new Date('2026-09-10T22:00:00.000Z');

function reading(over: Partial<Reading> = {}): Reading {
  return {
    id: 'r1',
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    temperature: 23.7,
    humidity: 62,
    co2: 861,
    createdAt: NOW.toISOString(),
    ...over,
  };
}

function device(over: Partial<Device> = {}): Device {
  return {
    id: 'd1',
    nodeId: 'elantris',
    zoneId: 'z1',
    name: 'CO2 Generator',
    description: null,
    gpio: 5,
    onDelayDuration: 300,
    onAt: null,
    offAt: null,
    onLevel: 0,
    rulesEnabled: false,
    role: null,
    isOn: false,
    canTurnOn: true,
    canTurnOnAt: null,
    ...over,
  };
}

function setup(readings: Reading[], devices: Device[] = []): HTMLElement {
  vi.setSystemTime(NOW);
  TestBed.configureTestingModule({
    imports: [Dashboard],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          latestReadings: () => of(readings),
          devices: () => of(devices),
        },
      },
      {
        provide: RealtimeService,
        useValue: {
          readings: signal({}),
          deviceState: signal(null),
          status: signal(null),
          connected: signal(true),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(Dashboard);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('Dashboard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows a card per node with all three gauges', () => {
    const el = setup([reading()]);
    expect(el.textContent).toContain('elantris');
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(3);
  });

  // A null CO2 must reach the gauge as null rather than being coerced on the
  // way through. Zero reads as "extremely low", which runs the burner.
  it('passes a null CO2 through as unknown', () => {
    const el = setup([reading({ co2: null })]);
    expect(el.textContent).toContain('—');
    expect(el.textContent).toContain('unknown');
  });

  // The shell banner only fires when an OWNED ROLE goes stale. A node can go
  // quiet without that, and a confident number with no age beside it is how
  // somebody trusts a reading from an hour ago.
  it('marks a card whose reading has stopped arriving', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const el = setup([reading({ createdAt: old })]);
    expect(el.textContent).toContain('no reading for');
    expect(el.querySelector('.card--stale')).not.toBeNull();
  });

  it('does not mark a fresh reading as stale', () => {
    const el = setup([reading()]);
    expect(el.textContent).not.toContain('no reading for');
    expect(el.querySelector('.card--stale')).toBeNull();
  });

  // Colour alone is not readable on a phone in sunlight, and this one means a
  // propane burner is alight.
  it('states an energised relay in words', () => {
    const el = setup([reading()], [device({ isOn: true })]);
    const relay = el.querySelector('.relay__state');
    expect(relay?.textContent?.trim()).toBe('ON');
    expect(el.querySelector('.relay--on')).not.toBeNull();
  });

  it('shows an idle relay as off', () => {
    const el = setup([reading()], [device({ isOn: false })]);
    expect(el.querySelector('.relay__state')?.textContent?.trim()).toBe('off');
    expect(el.querySelector('.relay--on')).toBeNull();
  });

  // Devices belong to the node they are wired to; showing another node's relay
  // on this card would misattribute which box is driving what.
  it('only lists relays belonging to that node', () => {
    const el = setup(
      [reading()],
      [device({ id: 'd2', nodeId: 'somewhere-else', name: 'Other Relay' })],
    );
    expect(el.textContent).not.toContain('Other Relay');
  });

  it('says so plainly when there is nothing to show', () => {
    expect(setup([]).textContent).toContain('No readings yet');
  });
});
