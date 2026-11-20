import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import {
  NodeKind,
  NodeStatus,
  type Device,
  type MetricKey,
  type Node,
  type Reading,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { fakeRealtime, pushDevice } from '../../testing/fake-realtime';
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
    agentVersion: null,
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

const ELANTRIS = node('elantris', {
  'scd4x-0': ['temperature', 'humidity', 'co2'],
});

function probe(
  sensorId: string,
  temperature: number,
  over: Partial<Reading> = {},
): Reading {
  return reading({
    id: sensorId,
    nodeId: 'pumphouse',
    sensorId,
    temperature,
    humidity: null,
    co2: null,
    ...over,
  });
}

function setup(
  readings: Reading[],
  devices: Device[] = [],
  nodes: Node[] = [ELANTRIS],
  pushed: Device[] = [],
): HTMLElement {
  vi.setSystemTime(NOW);
  const realtime = fakeRealtime();
  for (const pushedDevice of pushed) pushDevice(realtime, pushedDevice);
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
          nodes: () => of(nodes),
        },
      },
      { provide: RealtimeService, useValue: realtime },
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

  // The pumphouse: pipe probes measure temperature and nothing else. Empty
  // humidity and CO2 dials beside them would read as broken sensors.
  it('shows only the metrics each sensor declares', () => {
    const el = setup(
      [probe('28-a', 3.1), probe('28-b', 4.2), probe('28-c', 5.0)],
      [],
      [
        node('pumphouse', {
          '28-a': ['temperature'],
          '28-b': ['temperature'],
          '28-c': ['temperature'],
        }),
      ],
    );
    expect(el.querySelectorAll('mat-card')).toHaveLength(1);
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(3);
    expect(el.textContent).not.toContain('unknown');
    const captions = [...el.querySelectorAll('.gauge__sensor')].map((c) =>
      c.textContent?.trim(),
    );
    expect(captions).toEqual(['28-a', '28-b', '28-c']);
  });

  it('does not caption the gauges of a single-sensor node', () => {
    expect(setup([reading()]).querySelector('.gauge__sensor')).toBeNull();
  });

  // Until the node list arrives the reading decides: a null it never had is
  // no reason to draw a dial.
  it('falls back to the metrics a reading carries before nodes load', () => {
    const el = setup([probe('28-a', 3.1)], [], []);
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(1);
  });

  // One probe dying beside two working ones: `min` carries on without it, so
  // the card is the place that has to say which one went quiet.
  it('names the probe that has stopped reporting', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    const el = setup(
      [probe('28-a', 3.1), probe('28-b', 4.2, { createdAt: old })],
      [],
      [node('pumphouse', { '28-a': ['temperature'], '28-b': ['temperature'] })],
    );
    expect(el.querySelector('.card--stale')).not.toBeNull();
    expect(el.textContent?.replace(/\s+/g, ' ')).toContain(
      '28-b: no reading for 600s',
    );
    expect(el.textContent).not.toContain('28-a:');
  });

  it('says so plainly when there is nothing to show', () => {
    expect(setup([]).textContent).toContain('No readings yet');
  });

  it('keeps every pushed device state, not only the newest', () => {
    const heater = device({ id: 'd1', name: 'Heater', isOn: false });
    const tape = device({ id: 'd2', name: 'Heat tape', isOn: false });
    const page = setup(
      [reading()],
      [heater, tape],
      [ELANTRIS],
      [
        { ...heater, isOn: true },
        { ...tape, isOn: true },
      ],
    );
    expect(page.querySelectorAll('.relay--on')).toHaveLength(2);
  });
});
