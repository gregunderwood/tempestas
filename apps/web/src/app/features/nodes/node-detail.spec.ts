import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { Node, Reading, ReadingStats } from '@tempestas/domain';
import { NodeStatus } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { NodeDetail } from './node-detail';

function reading(over: Partial<Reading> = {}): Reading {
  return {
    id: 'r1',
    nodeId: 'elantris',
    sensorId: 'scd4x-0',
    temperature: 23.8,
    humidity: 63,
    co2: 481,
    createdAt: '2026-09-10T22:39:46.000Z',
    ...over,
  };
}

function statsOf(over: Partial<ReadingStats> = {}): ReadingStats {
  return {
    min: {
      temperature: reading({
        temperature: 17.5,
        createdAt: '2026-09-10T20:26:00.000Z',
      }),
      humidity: reading({ humidity: 54.9 }),
      co2: reading({ co2: 479 }),
    },
    max: {
      temperature: reading({ temperature: 23.8 }),
      humidity: reading({ humidity: 77.5 }),
      co2: reading({ co2: 866 }),
    },
    average: { temperature: 21.8, humidity: 66.4, co2: 584 },
    from: '2026-09-09T22:39:00.000Z',
    to: '2026-09-10T22:39:00.000Z',
    ...over,
  };
}

function node(): Node {
  return {
    id: 'n1',
    slug: 'elantris',
    displayName: 'elantris',
    location: null,
    kind: 'rpi',
    status: NodeStatus.Admitted,
    capabilities: null,
    agentVersion: '0.1.0',
    online: true,
    lastSeenAt: null,
    zoneId: null,
  } as unknown as Node;
}

function setup(
  opts: {
    stats?: ReadingStats;
    latest?: Reading[];
    live?: Record<string, Reading>;
  } = {},
): HTMLElement {
  TestBed.configureTestingModule({
    imports: [NodeDetail],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ApiService,
        useValue: {
          nodes: () => of([node()]),
          latestReadings: () => of(opts.latest ?? [reading()]),
          stats: () => of(opts.stats ?? statsOf()),
        },
      },
      {
        provide: RealtimeService,
        useValue: {
          readings: signal(opts.live ?? {}),
          deviceState: signal(null),
          status: signal(null),
          connected: signal(true),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(NodeDetail);
  fixture.componentRef.setInput('slug', 'elantris');
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('NodeDetail', () => {
  it('shows the current reading as gauges', () => {
    const el = setup();
    expect(el.querySelectorAll('temp-gauge')).toHaveLength(3);
    expect(el.textContent).toContain('23.8');
  });

  it('shows min, max and average for each metric', () => {
    const text = setup().textContent ?? '';
    for (const value of [
      '17.5',
      '23.8',
      '21.8',
      '54.9',
      '77.5',
      '66.4',
      '479',
      '866',
      '584',
    ]) {
      expect(text).toContain(value);
    }
  });

  // The clock time of an extreme matters as much as its value: a peak at 14:00
  // is the greenhouse working, the same peak at 03:00 is a fault.
  it('shows when an extreme happened, not just what it was', () => {
    expect(setup().querySelectorAll('.at').length).toBeGreaterThan(0);
  });

  // Every figure here can legitimately be absent. Zero would read as extremely
  // low CO2, which is the one direction that runs the burner.
  it('renders a missing statistic as an em-dash, never a zero', () => {
    const el = setup({
      stats: statsOf({
        average: { temperature: 21.8, humidity: 66.4, co2: null },
        min: { temperature: null, humidity: null, co2: null },
        max: { temperature: null, humidity: null, co2: null },
      }),
    });
    const row = [...el.querySelectorAll('tbody tr')].find((r) =>
      r.textContent?.includes('CO2'),
    );
    expect(row?.textContent).toContain('—');
    expect(row?.textContent).not.toContain('0 ');
  });

  // Same rule as everywhere else: the socket patches what the API established.
  it('prefers a live reading over the fetched one', () => {
    const el = setup({
      live: { elantris: reading({ temperature: 31.4 }) },
    });
    expect(el.textContent).toContain('31.4');
  });

  it('says so plainly when the node has never reported', () => {
    const el = setup({ latest: [] });
    expect(el.textContent).toContain('No readings from this node');
  });

  it('labels the window it is showing', () => {
    expect(setup().textContent).toContain('Last 24 hours');
  });
});
