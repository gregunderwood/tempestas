import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import {
  DeviceRole,
  type DeviceRuntime,
  type EquipmentRuntimeReport,
  type FreezeMarginReport,
  type Reading,
  type TimeInRangeReport,
  type ZoneFreezeMargin,
  type ZoneTimeInRange,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import {
  fakeRealtime,
  pushDevice,
  pushNode,
} from '../../testing/fake-realtime';
import { device, node } from '../zones/zone-fixtures';
import { PROPANE_UNIT_KEY } from './propane-units';
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
        propaneLitres: null,
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
        propaneLitres: null,
      },
    ],
    totalHoursOn: 4,
    totalStarts: 8,
    totalHoursUnknown: 1,
    inputBtuPerHour: null,
    totalPropaneLitres: null,
    ...overrides,
  };
}

function ratedBurnerRuntime(): DeviceRuntime {
  const unrated = burnerRuntime();
  return {
    ...unrated,
    inputBtuPerHour: 40_000,
    days: [
      { ...unrated.days[0], propaneLitres: 5 },
      { ...unrated.days[1], propaneLitres: 5 / 3 },
    ],
    totalPropaneLitres: 20 / 3,
  };
}

function report(devices: DeviceRuntime[]): EquipmentRuntimeReport {
  return { days: 2, generatedAt: '2026-09-09T19:00:00Z', devices };
}

function pumphouseFreezeMargin(): ZoneFreezeMargin {
  return {
    zoneId: 'pumphouse-zone',
    zoneSlug: 'pumphouse',
    zoneName: 'Pumphouse',
    timezone: 'America/Edmonton',
    nodeIds: ['patji'],
    warningBelowC: 3,
    isWarningFromRules: true,
    nights: [
      {
        from: '2026-09-09T00:30:00.000Z',
        to: '2026-09-09T12:30:00.000Z',
        inProgress: false,
        coldest: {
          temperatureC: 1.2,
          at: '2026-09-09T11:00:00.000Z',
          nodeId: 'patji',
          sensorId: 'pipe',
        },
        heating: [
          {
            deviceId: 'heater',
            deviceName: 'Heater',
            role: DeviceRole.Heater,
            state: 'off',
            onBelowC: 3,
            isOnBelowFromRule: true,
            isHeatOwed: true,
          },
        ],
        hoursBelowWarning: 3,
        hoursWithReadings: 12,
        concern: 'heat-off-while-cold',
      },
    ],
  };
}

function freezeMarginReport(zones: ZoneFreezeMargin[]): FreezeMarginReport {
  return {
    nights: 30,
    generatedAt: '2026-09-09T19:00:00Z',
    zones,
  };
}

function latestReading(nodeId: string): Reading {
  return {
    id: `${nodeId}-reading`,
    nodeId,
    sensorId: 'pipe',
    temperature: 1,
    humidity: null,
    co2: null,
    createdAt: '2026-09-09T19:00:00Z',
  };
}

function greenhouseTimeInRange(): ZoneTimeInRange {
  return {
    zoneId: 'greenhouse-zone',
    zoneSlug: 'greenhouse',
    zoneName: 'Greenhouse',
    timezone: 'America/Edmonton',
    nodeIds: ['elantris'],
    lowerBounds: [],
    upperBounds: [
      { role: DeviceRole.ExhaustFan, setpointC: 30, sensorSource: 'mean' },
    ],
    periods: [
      {
        kind: 'day',
        from: '2026-09-09T12:30:00.000Z',
        to: '2026-09-10T00:30:00.000Z',
        inProgress: false,
        hoursBelow: 0,
        hoursInRange: 9,
        hoursAbove: 3,
        hoursWithoutReadings: 0,
        extremes: {
          temperature: {
            value: 33.4,
            at: '2026-09-09T21:00:00.000Z',
            nodeId: 'elantris',
            sensorId: 'scd41',
          },
          humidity: null,
          co2: {
            value: 1450,
            at: '2026-09-09T15:00:00.000Z',
            nodeId: 'elantris',
            sensorId: 'scd41',
          },
        },
      },
    ],
  };
}

function timeInRangeReport(zones: ZoneTimeInRange[]): TimeInRangeReport {
  return { days: 30, generatedAt: '2026-09-09T19:00:00Z', zones };
}

interface ReportAnswers {
  freezeMargin?: Observable<FreezeMarginReport>[];
  timeInRange?: Observable<TimeInRangeReport>[];
}

interface RenderedReportsPage {
  page: HTMLElement;
  requestCount(): number;
  freezeMarginRequestCount(): number;
  timeInRangeRequestCount(): number;
  render(): void;
  realtime: ReturnType<typeof fakeRealtime>;
}

function renderReportsPage(
  answers: Observable<EquipmentRuntimeReport>[],
  { freezeMargin = [], timeInRange = [] }: ReportAnswers = {},
): RenderedReportsPage {
  let requests = 0;
  let freezeMarginRequests = 0;
  let timeInRangeRequests = 0;
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
          fetchFreezeMargin: () => {
            freezeMarginRequests += 1;
            return freezeMargin.shift() ?? NEVER;
          },
          fetchTimeInRange: () => {
            timeInRangeRequests += 1;
            return timeInRange.shift() ?? NEVER;
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
    freezeMarginRequestCount: () => freezeMarginRequests,
    timeInRangeRequestCount: () => timeInRangeRequests,
    render: () => {
      TestBed.tick();
      fixture.detectChanges();
    },
    realtime,
  };
}

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('lists the reports still to come, without the ones already here', () => {
    const { page } = renderReportsPage([NEVER]);
    const listed = Array.from(page.querySelectorAll('li')).map((item) =>
      item.textContent?.trim(),
    );
    expect(listed).toEqual(['CO2 enrichment', 'Node health']);
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

  describe('freeze margin', () => {
    it('shows a card per heated zone with each night and its concern', () => {
      const { page } = renderReportsPage([NEVER], {
        freezeMargin: [of(freezeMarginReport([pumphouseFreezeMargin()]))],
      });
      const card = page.querySelector('temp-freeze-margin-card');
      expect(card?.textContent).toContain('Pumphouse');
      expect(card?.textContent).toContain('1 night needs a look.');
      expect(card?.textContent).toContain('1.2 °C at 05:00');
      expect(card?.textContent).toContain('Heater off');
      expect(card?.textContent).toContain(
        'Heater was off at the coldest moment, below its 3 °C on-setpoint.',
      );
    });

    it('keeps nights past the first week folded away', () => {
      const zone = pumphouseFreezeMargin();
      const tenNights = Array.from({ length: 10 }, (_, index) => ({
        ...zone.nights[0],
        from: `2026-09-${String(index + 1).padStart(2, '0')}T00:30:00.000Z`,
      }));
      const { page } = renderReportsPage([NEVER], {
        freezeMargin: [
          of(freezeMarginReport([{ ...zone, nights: tenNights }])),
        ],
      });
      const tables = page.querySelectorAll('temp-freeze-night-table');
      expect(tables).toHaveLength(2);
      expect(tables[0].querySelectorAll('tbody th[scope="row"]')).toHaveLength(
        7,
      );
      expect(
        page.querySelectorAll('details temp-freeze-night-table tbody th'),
      ).toHaveLength(3);
    });

    it("fetches again once a heated zone's readings are a bucket past the report", () => {
      const rendered = renderReportsPage([NEVER], {
        freezeMargin: [
          of(freezeMarginReport([pumphouseFreezeMargin()])),
          of(freezeMarginReport([pumphouseFreezeMargin()])),
        ],
      });
      const pushReading = (nodeId: string, createdAt: string): void => {
        rendered.realtime.readings.update((readings) => ({
          ...readings,
          [nodeId]: { ...latestReading(nodeId), createdAt },
        }));
        rendered.render();
      };
      rendered.render();
      expect(rendered.freezeMarginRequestCount()).toBe(1);

      pushReading('elantris', '2026-09-09T19:30:00Z');
      pushReading('patji', '2026-09-09T19:05:00Z');
      expect(rendered.freezeMarginRequestCount()).toBe(1);

      pushReading('patji', '2026-09-09T19:11:00Z');
      expect(rendered.freezeMarginRequestCount()).toBe(2);

      pushReading('patji', '2026-09-09T19:15:00Z');
      expect(rendered.freezeMarginRequestCount()).toBe(2);
    });

    it('says so when no zone has heating', () => {
      const { page } = renderReportsPage([NEVER], {
        freezeMargin: [of(freezeMarginReport([]))],
      });
      expect(page.textContent).toContain(
        'No zone has a heater or heat tape yet.',
      );
    });

    it('says it could not load the freeze margin when the request fails', () => {
      const { page } = renderReportsPage([NEVER], {
        freezeMargin: [throwError(() => new Error('offline'))],
      });
      expect(page.textContent).toContain('Could not load the freeze margin.');
    });
  });

  describe('time in range', () => {
    it('shows a card per zone with its band and each period', () => {
      const { page } = renderReportsPage([NEVER], {
        timeInRange: [of(timeInRangeReport([greenhouseTimeInRange()]))],
      });
      const card = page.querySelector('temp-time-in-range-card');
      expect(card?.textContent).toContain('Greenhouse');
      expect(card?.textContent).toContain(
        'No lower bound: no always-on heater or heat tape thermostat here.',
      );
      expect(card?.textContent).toContain(
        "Above: over the exhaust fan's 30 °C on-setpoint, read from the average of every probe.",
      );
      expect(card?.textContent).toContain('Days: 75% in range, 25% above');
      expect(card?.textContent).toContain('High 33.4 °C at 15:00');
      expect(card?.textContent).toContain('High 1450 ppm CO₂ at 09:00');
    });

    it('leaves out the column for a side with no bound', () => {
      const { page } = renderReportsPage([NEVER], {
        timeInRange: [of(timeInRangeReport([greenhouseTimeInRange()]))],
      });
      const headers = Array.from(
        page.querySelectorAll('temp-time-in-range-card thead th'),
      ).map((header) => header.textContent?.trim());
      expect(headers).toEqual([
        'Period',
        'Extreme',
        'In range',
        'Above',
        'No readings',
      ]);
    });

    it('comes after the freeze margin', () => {
      const { page } = renderReportsPage([NEVER]);
      const headings = Array.from(page.querySelectorAll('h2')).map((heading) =>
        heading.textContent?.trim(),
      );
      expect(headings).toEqual([
        'Equipment runtime',
        'Freeze margin',
        'Time in range',
      ]);
    });

    it("fetches again once a zone's readings are three buckets past the report", () => {
      const rendered = renderReportsPage([NEVER], {
        timeInRange: [
          of(timeInRangeReport([greenhouseTimeInRange()])),
          of(timeInRangeReport([greenhouseTimeInRange()])),
        ],
      });
      const pushReading = (createdAt: string): void => {
        rendered.realtime.readings.update((readings) => ({
          ...readings,
          elantris: { ...latestReading('elantris'), createdAt },
        }));
        rendered.render();
      };
      rendered.render();
      pushReading('2026-09-09T19:14:00Z');
      expect(rendered.timeInRangeRequestCount()).toBe(1);
      pushReading('2026-09-09T19:15:00Z');
      expect(rendered.timeInRangeRequestCount()).toBe(2);
    });

    it('says so when no zone has a node', () => {
      const { page } = renderReportsPage([NEVER], {
        timeInRange: [of(timeInRangeReport([]))],
      });
      expect(page.textContent).toContain('No zone has a node yet.');
    });

    it('says it could not load the time in range when the request fails', () => {
      const { page } = renderReportsPage([NEVER], {
        timeInRange: [throwError(() => new Error('offline'))],
      });
      expect(page.textContent).toContain('Could not load the time in range.');
    });
  });

  describe('propane used', () => {
    function propaneUnitToggles(page: HTMLElement): HTMLButtonElement[] {
      return Array.from(
        page.querySelectorAll<HTMLButtonElement>('.temp-propane-unit button'),
      );
    }

    function propaneTotal(page: HTMLElement): string | undefined {
      return page.querySelector('.runtime-propane')?.textContent?.trim();
    }

    it('shows nothing extra for a device without a burner rating', () => {
      const { page } = renderReportsPage([of(report([burnerRuntime()]))]);
      expect(propaneUnitToggles(page)).toHaveLength(0);
      expect(page.textContent).not.toContain('Propane');
    });

    it('shows a rated burner in litres by default, per day and in total', () => {
      const { page } = renderReportsPage([of(report([ratedBurnerRuntime()]))]);
      expect(propaneTotal(page)).toBe('6.7 L');
      const dayCells = Array.from(
        page.querySelectorAll('.runtime-days tbody tr td:last-child'),
      ).map((cell) => cell.textContent?.trim());
      expect(dayCells).toEqual(['1.7 L', '5.0 L']);
    });

    it('says the estimate covers known hours only, at the rating', () => {
      const { page } = renderReportsPage([of(report([ratedBurnerRuntime()]))]);
      expect(page.textContent).toContain(
        "Propane is estimated at the burner's 40,000 BTU/hr rating, from known hours on only; unknown hours are not estimated.",
      );
    });

    it('switches every card to pounds and remembers the choice', () => {
      const rendered = renderReportsPage([of(report([ratedBurnerRuntime()]))]);
      const pounds = propaneUnitToggles(rendered.page).find((toggle) =>
        toggle.textContent?.includes('Pounds'),
      );
      pounds?.click();
      rendered.render();
      expect(propaneTotal(rendered.page)).toBe('7.5 lb');
      expect(localStorage.getItem(PROPANE_UNIT_KEY)).toBe('pounds');
    });

    it('converts only the rated card when a rated and an unrated device share the page', () => {
      const unratedHeatTape = burnerRuntime({
        deviceId: 'heat-tape',
        deviceName: 'Heat tape',
      });
      const rendered = renderReportsPage([
        of(report([ratedBurnerRuntime(), unratedHeatTape])),
      ]);
      const [ratedCard, unratedCard] = Array.from(
        rendered.page.querySelectorAll<HTMLElement>(
          'temp-equipment-runtime-card',
        ),
      );
      const unratedCardText = unratedCard.textContent;
      expect(propaneUnitToggles(rendered.page)).toHaveLength(2);
      expect(unratedCardText).not.toContain('Propane');
      expect(unratedCard.querySelector('.runtime-propane')).toBeNull();
      expect(unratedCard.querySelector('.runtime-propane-note')).toBeNull();

      const pounds = propaneUnitToggles(rendered.page).find((toggle) =>
        toggle.textContent?.includes('Pounds'),
      );
      pounds?.click();
      rendered.render();
      expect(
        ratedCard.querySelector('.runtime-propane')?.textContent?.trim(),
      ).toBe('7.5 lb');
      expect(unratedCard.textContent).toBe(unratedCardText);
    });

    it('opens on the unit chosen last time', () => {
      localStorage.setItem(PROPANE_UNIT_KEY, 'pounds');
      const { page } = renderReportsPage([of(report([ratedBurnerRuntime()]))]);
      expect(propaneTotal(page)).toBe('7.5 lb');
    });
  });
});
