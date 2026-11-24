import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import {
  DeviceRole,
  type DeviceRuntime,
  type EquipmentRuntimeReport,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  fakeRealtime,
  pushDevice,
  pushNode,
} from '../../testing/fake-realtime';
import { device, node } from '../zones/zone-fixtures';
import { ReportsPage } from './reports-page';

function burnerRuntime(overrides: Partial<DeviceRuntime> = {}): DeviceRuntime {
  return {
    deviceId: 'burner',
    deviceName: 'CO2 burner',
    role: DeviceRole.Co2Generator,
    nodeId: 'elantris',
    zoneId: 'greenhouse',
    timezone: 'America/Vancouver',
    addedAt: '2026-01-01T00:00:00.000Z',
    days: [
      {
        date: '2026-09-08',
        hoursOn: 3,
        hoursOff: 20,
        hoursUnknown: 1,
        starts: 6,
        shortestRunMinutes: 4,
        hasRunCappedAtLastSeen: false,
        isBeforeDeviceAdded: false,
      },
      {
        date: '2026-09-09',
        hoursOn: 1,
        hoursOff: 10,
        hoursUnknown: 0,
        starts: 2,
        shortestRunMinutes: 12,
        hasRunCappedAtLastSeen: false,
        isBeforeDeviceAdded: false,
      },
    ],
    totalHoursOn: 4,
    totalStarts: 8,
    totalHoursUnknown: 1,
    ...overrides,
  };
}

function report(devices: DeviceRuntime[]): EquipmentRuntimeReport {
  return { days: 2, generatedAt: '2026-09-09T19:00:00Z', devices };
}

interface RenderedReportsPage {
  page: HTMLElement;
  requestCount(): number;
  render(): void;
  realtime: ReturnType<typeof fakeRealtime>;
}

function renderReportsPage(
  answers: Observable<EquipmentRuntimeReport>[],
): RenderedReportsPage {
  let requests = 0;
  const realtime = fakeRealtime();
  TestBed.configureTestingModule({
    imports: [ReportsPage],
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: ApiService,
        useValue: {
          fetchEquipmentRuntime: () => {
            requests += 1;
            return answers.shift() ?? NEVER;
          },
        },
      },
      { provide: RealtimeService, useValue: realtime },
    ],
  });
  const fixture = TestBed.createComponent(ReportsPage);
  fixture.detectChanges();
  return {
    page: fixture.nativeElement as HTMLElement,
    requestCount: () => requests,
    render: () => {
      TestBed.tick();
      fixture.detectChanges();
    },
    realtime,
  };
}

describe('ReportsPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lists the reports still to come, without equipment runtime', () => {
    const { page } = renderReportsPage([NEVER]);
    const listed = Array.from(page.querySelectorAll('li')).map((item) =>
      item.textContent?.trim(),
    );
    expect(listed).toEqual([
      'Time in range',
      'Freeze margin',
      'CO2 enrichment',
      'Node health',
    ]);
  });

  it('shows a card per device with its totals and shortest run', () => {
    const { page } = renderReportsPage([of(report([burnerRuntime()]))]);
    const card = page.querySelector('temp-equipment-runtime-card');
    expect(card?.textContent).toContain('CO2 burner');
    expect(card?.textContent).toContain('CO₂ generator · elantris');
    expect(card?.textContent).toContain('4.0 h');
    expect(card?.textContent).toContain('8');
    expect(card?.textContent).toContain('4.0 min');
    expect(card?.querySelectorAll('svg g')).toHaveLength(2);
  });

  it('counts and lists only the days since a device was added', () => {
    const addedYesterday = burnerRuntime();
    addedYesterday.days[0] = {
      ...addedYesterday.days[0],
      hoursOn: 0,
      hoursOff: 0,
      hoursUnknown: 0,
      starts: 0,
      shortestRunMinutes: null,
      isBeforeDeviceAdded: true,
    };
    const { page } = renderReportsPage([of(report([addedYesterday]))]);
    const card = page.querySelector('temp-equipment-runtime-card');
    expect(card?.querySelector('.runtime-legend')?.textContent).toContain(
      '1 day to today',
    );
    expect(card?.querySelectorAll('.runtime-days tbody tr')).toHaveLength(1);
  });

  it('says when a run was cut at the node going offline', () => {
    const capped = burnerRuntime();
    capped.days[1] = { ...capped.days[1], hasRunCappedAtLastSeen: true };
    const { page } = renderReportsPage([of(report([capped]))]);
    expect(page.textContent).toContain(
      'The node went offline mid-run on 1 day',
    );
  });

  it('says it could not load the report when the request fails', () => {
    const { page } = renderReportsPage([
      throwError(() => new Error('offline')),
    ]);
    expect(page.textContent).toContain('Could not load the equipment runtime.');
  });

  it('says so when there are no devices', () => {
    const { page } = renderReportsPage([of(report([]))]);
    expect(page.textContent).toContain('No devices yet.');
  });

  it('fetches again when a device switches', () => {
    const rendered = renderReportsPage([
      of(report([burnerRuntime()])),
      of(report([burnerRuntime()])),
    ]);
    rendered.render();
    expect(rendered.requestCount()).toBe(1);
    pushDevice(rendered.realtime, device());
    rendered.render();
    expect(rendered.requestCount()).toBe(2);
  });

  it('fetches again when a node goes offline or comes back', () => {
    const rendered = renderReportsPage([
      of(report([burnerRuntime()])),
      of(report([burnerRuntime()])),
    ]);
    rendered.render();
    expect(rendered.requestCount()).toBe(1);
    pushNode(rendered.realtime, { ...node('elantris', null), online: false });
    rendered.render();
    expect(rendered.requestCount()).toBe(2);
  });
});
