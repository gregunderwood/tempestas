import { DeviceRole } from '@tempestas/domain';
import type { NodeSighting, RuntimeTransition } from '../devices/relay-spans';
import type { TemperatureBucketRow } from '../readings/readings.service';
import {
  buildZoneHistoryReport,
  type HistoryDevice,
  type ZoneHistoryInput,
} from './zone-history';

const GREENHOUSE = 'greenhouse-zone';
const PUMPHOUSE = 'pumphouse-zone';
const FROM = new Date('2026-11-22T12:00:00Z');
const NOW = new Date('2026-11-23T12:00:00Z');
const ONLINE: NodeSighting = { isOnline: true, lastHeardAt: null };

const HEATER: HistoryDevice = {
  id: 'heater-device',
  name: 'Heater',
  role: DeviceRole.Heater,
  nodeId: 'patji',
  zoneId: PUMPHOUSE,
  addedAt: new Date('2026-01-01T00:00:00Z'),
};

const BURNER: HistoryDevice = {
  id: 'burner-device',
  name: 'CO2 burner',
  role: DeviceRole.Co2Generator,
  nodeId: 'elantris',
  zoneId: GREENHOUSE,
  addedAt: new Date('2026-01-01T00:00:00Z'),
};

function heaterRow(
  observedAt: string,
  energised: boolean | null,
  isNodeOffline = false,
): RuntimeTransition {
  return {
    nodeId: 'patji',
    pin: 17,
    energised,
    deviceId: HEATER.id,
    observedAt: new Date(observedAt),
    isNodeOffline,
  };
}

function bucket(
  nodeId: string,
  sensorId: string,
  at: string,
  averageC: number,
): TemperatureBucketRow {
  return {
    nodeId,
    sensorId,
    at: new Date(at),
    averageC,
    lowestC: averageC - 0.5,
    highestC: averageC + 0.5,
    sampleCount: 30,
  };
}

function buildReport(overrides: Partial<ZoneHistoryInput> = {}) {
  return buildZoneHistoryReport({
    zoneIds: [GREENHOUSE, PUMPHOUSE],
    nodes: [
      { slug: 'elantris', zoneId: GREENHOUSE },
      { slug: 'patji', zoneId: PUMPHOUSE },
    ],
    devices: [BURNER, HEATER],
    transitions: [],
    sightingsByNode: new Map([
      ['elantris', ONLINE],
      ['patji', ONLINE],
    ]),
    temperatureBuckets: [],
    from: FROM,
    now: NOW,
    ...overrides,
  });
}

function findHeaterSpans(overrides: Partial<ZoneHistoryInput>) {
  const pumphouse = buildReport(overrides).zones[1];
  return pumphouse.devices[0].spans;
}

describe('buildZoneHistoryReport', () => {
  it('gives every zone its own probes and devices', () => {
    const report = buildReport({
      temperatureBuckets: [
        bucket('patji', 'pipes', '2026-11-23T03:00:00Z', 2.5),
        bucket('elantris', 'scd41', '2026-11-23T03:00:00Z', 18),
      ],
    });
    expect(report.from).toBe(FROM.toISOString());
    expect(report.to).toBe(NOW.toISOString());
    expect(report.zones.map((zone) => zone.zoneId)).toEqual([
      GREENHOUSE,
      PUMPHOUSE,
    ]);
    expect(report.zones[0].probes.map((probe) => probe.sensorId)).toEqual([
      'scd41',
    ]);
    expect(report.zones[1].probes.map((probe) => probe.sensorId)).toEqual([
      'pipes',
    ]);
    expect(report.zones[1].devices.map((device) => device.deviceId)).toEqual([
      HEATER.id,
    ]);
  });

  it('keeps each probe on its own line, in name order, oldest bucket first', () => {
    const report = buildReport({
      temperatureBuckets: [
        bucket('patji', 'pipes', '2026-11-23T03:05:00Z', 2),
        bucket('patji', 'air', '2026-11-23T03:00:00Z', 4),
        bucket('patji', 'pipes', '2026-11-23T03:00:00Z', 3),
      ],
    });
    const [air, pipes] = report.zones[1].probes;
    expect(pipes.buckets.map((entry) => entry.averageC)).toEqual([3, 2]);
    expect(pipes.buckets[0]).toEqual({
      at: '2026-11-23T03:00:00.000Z',
      averageC: 3,
      lowestC: 2.5,
      highestC: 3.5,
      sampleCount: 30,
    });
    expect(air.buckets).toHaveLength(1);
  });

  it('leaves out readings from a node in no zone', () => {
    const report = buildReport({
      nodes: [{ slug: 'patji', zoneId: null }],
      temperatureBuckets: [bucket('patji', 'pipes', '2026-11-23T03:00:00Z', 2)],
    });
    expect(report.zones[1].probes).toEqual([]);
  });

  it('starts from the row in force before the window opened', () => {
    const spans = findHeaterSpans({
      transitions: [
        heaterRow('2026-11-20T00:00:00Z', true),
        heaterRow('2026-11-23T06:00:00Z', false),
      ],
    });
    expect(spans).toEqual([
      {
        state: 'on',
        from: '2026-11-22T12:00:00.000Z',
        to: '2026-11-23T06:00:00.000Z',
      },
      {
        state: 'off',
        from: '2026-11-23T06:00:00.000Z',
        to: '2026-11-23T12:00:00.000Z',
      },
    ]);
  });

  it('draws time with no history as unknown, never off', () => {
    const spans = findHeaterSpans({
      transitions: [heaterRow('2026-11-23T06:00:00Z', false)],
    });
    expect(spans.map((span) => [span.state, span.from])).toEqual([
      ['unknown', '2026-11-22T12:00:00.000Z'],
      ['off', '2026-11-23T06:00:00.000Z'],
    ]);
  });

  it('marks the time a node was offline as unknown', () => {
    const spans = findHeaterSpans({
      transitions: [
        heaterRow('2026-11-22T10:00:00Z', true),
        heaterRow('2026-11-23T01:00:00Z', null, true),
        heaterRow('2026-11-23T04:00:00Z', false),
      ],
    });
    expect(spans.map((span) => [span.state, span.to])).toEqual([
      ['on', '2026-11-23T01:00:00.000Z'],
      ['unknown', '2026-11-23T04:00:00.000Z'],
      ['off', '2026-11-23T12:00:00.000Z'],
    ]);
  });

  it('cuts an open run at last-seen on a node that went quiet, then unknown to now', () => {
    const spans = findHeaterSpans({
      transitions: [heaterRow('2026-11-23T02:00:00Z', true)],
      sightingsByNode: new Map([
        [
          'patji',
          { isOnline: false, lastHeardAt: new Date('2026-11-23T05:00:00Z') },
        ],
      ]),
    });
    expect(spans.map((span) => [span.state, span.from, span.to])).toEqual([
      ['unknown', '2026-11-22T12:00:00.000Z', '2026-11-23T02:00:00.000Z'],
      ['on', '2026-11-23T02:00:00.000Z', '2026-11-23T05:00:00.000Z'],
      ['unknown', '2026-11-23T05:00:00.000Z', '2026-11-23T12:00:00.000Z'],
    ]);
  });

  it('starts a device added during the window when it was added', () => {
    const spans = findHeaterSpans({
      devices: [{ ...HEATER, addedAt: new Date('2026-11-23T08:00:00Z') }],
      transitions: [heaterRow('2026-11-23T09:00:00Z', true)],
    });
    expect(spans.map((span) => [span.state, span.from])).toEqual([
      ['unknown', '2026-11-23T08:00:00.000Z'],
      ['on', '2026-11-23T09:00:00.000Z'],
    ]);
  });

  it('ignores history on the pin from before the device claimed it', () => {
    const spans = findHeaterSpans({
      transitions: [
        { ...heaterRow('2026-11-23T01:00:00Z', true), deviceId: null },
        heaterRow('2026-11-23T03:00:00Z', false),
      ],
    });
    expect(spans.map((span) => span.state)).toEqual(['unknown', 'off']);
  });

  it('merges back-to-back stretches in the same state', () => {
    const spans = findHeaterSpans({
      transitions: [
        heaterRow('2026-11-23T01:00:00Z', null),
        heaterRow('2026-11-23T02:00:00Z', false),
      ],
    });
    expect(spans.map((span) => [span.state, span.to])).toEqual([
      ['unknown', '2026-11-23T02:00:00.000Z'],
      ['off', '2026-11-23T12:00:00.000Z'],
    ]);
  });
});
