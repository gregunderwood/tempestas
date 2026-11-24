import type {
  DeviceRunHistory,
  Reading,
  TemperatureBucket,
  ZoneHistoryReport,
} from '@tempestas/domain';
import {
  buildLinePath,
  buildRunStrip,
  buildTimeLabels,
  buildZoneHistoryCharts,
  mergePushedReadings,
  type ZoneHistoryChartsInput,
} from './zone-history-view';
import { NOW, device, pumphouseHistory } from './zone-fixtures';

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const NOW_MS = NOW.getTime();
const WINDOW = { fromMs: NOW_MS - 24 * MILLISECONDS_PER_HOUR, toMs: NOW_MS };
const SCALE = { topC: 10, bottomC: 0 };

function minutesBeforeNow(minutes: number): string {
  return new Date(NOW_MS - minutes * MILLISECONDS_PER_MINUTE).toISOString();
}

function bucketAt(minutesAgo: number, averageC: number): TemperatureBucket {
  return {
    at: minutesBeforeNow(minutesAgo),
    averageC,
    lowestC: averageC,
    highestC: averageC,
    sampleCount: 1,
  };
}

function pushedReading(
  createdAt: string,
  temperature: number,
  sensorId = 'pipes',
): Reading {
  return {
    id: `r-${createdAt}-${sensorId}`,
    nodeId: 'patji',
    sensorId,
    temperature,
    humidity: null,
    co2: null,
    createdAt,
  };
}

function chartsFor(overrides: Partial<ZoneHistoryChartsInput> = {}) {
  return buildZoneHistoryCharts({
    report: pumphouseHistory(),
    zones: [
      {
        zoneId: 'z-pump',
        timezone: 'America/Vancouver',
        decidingProbeKeys: ['patji/pipes'],
      },
    ],
    pushedReadings: [],
    zoneIdByNodeSlug: new Map([['patji', 'z-pump']]),
    pushedDevices: [],
    now: NOW_MS,
    ...overrides,
  });
}

function heaterHistory(spans: DeviceRunHistory['spans']): DeviceRunHistory {
  return {
    deviceId: 'd-heater',
    deviceName: 'Heater',
    role: null,
    nodeId: 'patji',
    spans,
  };
}

describe('buildZoneHistoryCharts', () => {
  it('draws each zone that has history, with its probes and devices', () => {
    const chart = chartsFor().get('z-pump');
    expect(chart?.hasReadings).toBe(true);
    expect(chart?.lines).toHaveLength(1);
    expect(chart?.lines[0]).toMatchObject({
      label: 'pipes',
      isDeciding: true,
    });
    expect(chart?.strips.map((strip) => strip.name)).toEqual(['Heater']);
  });

  it('names the coldest and warmest moments in the zone clock', () => {
    const chart = chartsFor({
      zones: [
        {
          zoneId: 'z-pump',
          timezone: 'Asia/Kolkata',
          decidingProbeKeys: ['patji/pipes'],
        },
      ],
    }).get('z-pump');
    expect(chart?.extremes).toBe(
      'Low 2.9 °C near 16:44 · high 3.9 °C near 16:50',
    );
    expect(chart?.screenReaderText).toContain('from one probe');
  });

  it('scales to whole degrees at least four apart', () => {
    const chart = chartsFor().get('z-pump');
    expect(chart?.bottomLabel).toBe('1 °C');
    expect(chart?.topLabel).toBe('5 °C');
  });

  it('says so when a zone has no readings', () => {
    const report = pumphouseHistory();
    report.zones[0].probes = [];
    const chart = chartsFor({ report }).get('z-pump');
    expect(chart?.hasReadings).toBe(false);
    expect(chart?.extremes).toBeNull();
    expect(chart?.screenReaderText).toBe(
      'No temperature readings in the last 24 hours.',
    );
  });

  it('leaves out a zone the report does not cover', () => {
    const charts = chartsFor({
      zones: [{ zoneId: 'z-other', timezone: 'UTC', decidingProbeKeys: [] }],
    });
    expect(charts.size).toBe(0);
  });

  it('adds pushed readings from the zone after the fetch, and ignores older and foreign ones', () => {
    const later = NOW_MS + 30 * MILLISECONDS_PER_MINUTE;
    const report: ZoneHistoryReport = pumphouseHistory();
    const charts = chartsFor({
      report,
      now: later,
      pushedReadings: [
        pushedReading(minutesBeforeNow(1), 40),
        pushedReading(new Date(later - 60_000).toISOString(), 8),
        {
          ...pushedReading(new Date(later).toISOString(), 99),
          nodeId: 'elsewhere',
        },
      ],
    });
    const chart = charts.get('z-pump');
    expect(chart?.topLabel).toBe('8 °C');
    expect(chart?.extremes).toContain('high 8.0 °C');
  });

  it('names a probe by its node too when the zone has several nodes', () => {
    const later = NOW_MS + 60_000;
    const chart = chartsFor({
      now: later,
      zoneIdByNodeSlug: new Map([
        ['patji', 'z-pump'],
        ['braize', 'z-pump'],
      ]),
      pushedReadings: [
        {
          ...pushedReading(new Date(later).toISOString(), 5),
          nodeId: 'braize',
        },
      ],
    }).get('z-pump');
    expect(chart?.lines.map((line) => line.label)).toEqual([
      'braize/pipes',
      'patji/pipes',
    ]);
    expect(chart?.lines.map((line) => line.styleIndex)).toEqual([0, 1]);
  });

  it('falls back to UTC, and says so, for a timezone the browser does not know', () => {
    const chart = chartsFor({
      zones: [
        { zoneId: 'z-pump', timezone: 'Mars/Olympus', decidingProbeKeys: [] },
      ],
    }).get('z-pump');
    expect(chart?.extremes).toContain('11:14 UTC');
  });

  it('moves the window on with the clock, dropping buckets that fall out of it', () => {
    const chart = chartsFor({
      now: NOW_MS + 15 * MILLISECONDS_PER_HOUR,
    }).get('z-pump');
    expect(chart?.hasReadings).toBe(false);
  });
});

describe('mergePushedReadings', () => {
  it('folds a reading into the bucket the server would put it in', () => {
    const bucketStart = new Date(Math.floor(NOW_MS / 300_000) * 300_000);
    const [series] = mergePushedReadings(
      [
        {
          nodeId: 'patji',
          sensorId: 'pipes',
          buckets: [
            {
              at: bucketStart.toISOString(),
              averageC: 4,
              lowestC: 3,
              highestC: 5,
              sampleCount: 3,
            },
          ],
        },
      ],
      [pushedReading(new Date(bucketStart.getTime() + 1_000).toISOString(), 8)],
    );
    expect(series.buckets).toEqual([
      {
        at: bucketStart.toISOString(),
        averageC: 5,
        lowestC: 3,
        highestC: 8,
        sampleCount: 4,
      },
    ]);
  });

  it('starts a new probe for a sensor the fetch did not have', () => {
    const series = mergePushedReadings(
      [],
      [pushedReading(NOW.toISOString(), 6, 'air')],
    );
    expect(series.map((probe) => probe.key)).toEqual(['patji/air']);
    expect(series[0].buckets[0]).toMatchObject({ averageC: 6, sampleCount: 1 });
  });
});

describe('buildLinePath', () => {
  it('joins neighbouring buckets and breaks the line across a gap', () => {
    const path = buildLinePath(
      [bucketAt(60, 5), bucketAt(55, 6), bucketAt(30, 4), bucketAt(25, 4)],
      SCALE,
      WINDOW,
    );
    const commands = path.split(' ').filter((part) => /^[ML]/.test(part));
    expect(commands.map((command) => command[0])).toEqual(['M', 'L', 'M', 'L']);
  });

  it('gives a lone bucket a tick so it shows', () => {
    expect(buildLinePath([bucketAt(60, 5)], SCALE, WINDOW)).toMatch(/h4$/);
  });

  it('puts the coldest reading at the bottom and the warmest at the top', () => {
    const path = buildLinePath(
      [bucketAt(10, 0), bucketAt(5, 10)],
      SCALE,
      WINDOW,
    );
    expect(path).toMatch(/^M\S+ 100 L\S+ 0$/);
  });
});

describe('buildTimeLabels', () => {
  it('labels whole local quarter-days away from the edges', () => {
    const formatClock = (instantMs: number): string =>
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: 'Asia/Kolkata',
      }).format(instantMs);
    const labels = buildTimeLabels(WINDOW, formatClock);
    expect(labels.map((label) => label.text)).toEqual([
      '06:00',
      '12:00',
      '18:00',
      '00:00',
    ]);
    for (const label of labels) {
      expect(label.atPercent).toBeGreaterThanOrEqual(10);
      expect(label.atPercent).toBeLessThanOrEqual(90);
    }
  });
});

describe('buildRunStrip', () => {
  it('draws unknown apart from off, and counts only a start after a known off', () => {
    const strip = buildRunStrip(
      heaterHistory([
        {
          state: 'unknown',
          from: minutesBeforeNow(1440),
          to: minutesBeforeNow(1200),
        },
        {
          state: 'on',
          from: minutesBeforeNow(1200),
          to: minutesBeforeNow(1140),
        },
        {
          state: 'off',
          from: minutesBeforeNow(1140),
          to: minutesBeforeNow(600),
        },
        { state: 'on', from: minutesBeforeNow(600), to: minutesBeforeNow(570) },
        { state: 'off', from: minutesBeforeNow(570), to: NOW.toISOString() },
      ]),
      null,
      WINDOW,
    );
    expect(strip.segments.map((segment) => segment.state)).toEqual([
      'unknown',
      'on',
      'off',
      'on',
      'off',
    ]);
    expect(strip.summary).toBe('on 1 h 30 min · 1 start · unknown 4 h 0 min');
    expect(strip.screenReaderText).toBe(
      'Heater, last 24 hours: on 1 h 30 min · 1 start · unknown 4 h 0 min.',
    );
  });

  it('leaves the time before a device was added empty rather than unknown', () => {
    const strip = buildRunStrip(
      heaterHistory([
        { state: 'off', from: minutesBeforeNow(360), to: NOW.toISOString() },
      ]),
      null,
      WINDOW,
    );
    expect(strip.segments).toEqual([
      { state: 'off', fromPercent: 75, widthPercent: 25 },
    ]);
    expect(strip.summary).toBe('never on · 0 starts');
  });

  it('runs the last span on to now and drops what fell out of the window', () => {
    const later = {
      fromMs: WINDOW.fromMs + MILLISECONDS_PER_HOUR,
      toMs: NOW_MS + MILLISECONDS_PER_HOUR,
    };
    const strip = buildRunStrip(
      heaterHistory([
        {
          state: 'off',
          from: minutesBeforeNow(1440),
          to: minutesBeforeNow(1410),
        },
        { state: 'on', from: minutesBeforeNow(1410), to: NOW.toISOString() },
      ]),
      null,
      later,
    );
    expect(strip.segments).toEqual([
      { state: 'on', fromPercent: 0, widthPercent: 100 },
    ]);
  });

  it('draws a pushed switch at once, from when the relay switched', () => {
    const strip = buildRunStrip(
      heaterHistory([
        { state: 'off', from: minutesBeforeNow(1440), to: NOW.toISOString() },
      ]),
      device({ isOn: true, onAt: minutesBeforeNow(144) }),
      WINDOW,
    );
    expect(strip.segments).toEqual([
      { state: 'off', fromPercent: 0, widthPercent: 90 },
      { state: 'on', fromPercent: 90, widthPercent: 10 },
    ]);
    expect(strip.summary).toContain('1 start');
  });

  it('ignores a pushed state the history already has or has moved past', () => {
    const spans: DeviceRunHistory['spans'] = [
      { state: 'on', from: minutesBeforeNow(1440), to: minutesBeforeNow(60) },
      { state: 'unknown', from: minutesBeforeNow(60), to: NOW.toISOString() },
    ];
    const alreadyKnown = buildRunStrip(
      heaterHistory(spans.slice(0, 1)),
      device({ isOn: true, onAt: minutesBeforeNow(1440) }),
      WINDOW,
    );
    const overtaken = buildRunStrip(
      heaterHistory(spans),
      device({ isOn: false, offAt: minutesBeforeNow(120) }),
      WINDOW,
    );
    expect(alreadyKnown.segments).toHaveLength(1);
    expect(overtaken.segments.map((segment) => segment.state)).toEqual([
      'on',
      'unknown',
    ]);
  });

  it('ignores a pushed device that has never switched', () => {
    const strip = buildRunStrip(
      heaterHistory([
        { state: 'off', from: minutesBeforeNow(1440), to: NOW.toISOString() },
      ]),
      device({ isOn: true, onAt: null }),
      WINDOW,
    );
    expect(strip.segments).toHaveLength(1);
  });
});
