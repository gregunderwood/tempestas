import {
  NodeKind,
  NodeStatus,
  type DayNightStats,
  type Node,
  type Reading,
  type SystemStatus,
  type Zone,
  type ZoneHistoryReport,
} from '@tempestas/domain';

export const NODE_SLUG = 'elantris';
export const NODE_DISPLAY_NAME = 'Greenhouse controller';
export const ZONE_DISPLAY_NAME = 'Greenhouse';
const SENSOR_ID = 'scd4x';

export function buildNode(): Node {
  return {
    id: 'node-elantris',
    slug: NODE_SLUG,
    displayName: NODE_DISPLAY_NAME,
    location: 'Greenhouse',
    kind: NodeKind.RaspberryPi,
    status: NodeStatus.Admitted,
    online: true,
    lastSeenAt: null,
    agentName: 'agent-linux',
    agentVersion: '1.0.0',
    availableUpdate: null,
    contractStanding: 'current',
    capabilities: {
      contractVersion: 1,
      sensors: [
        {
          sensorId: SENSOR_ID,
          kind: 'scd4x',
          metrics: ['temperature', 'humidity', 'co2'],
          sampleIntervalMs: 10_000,
        },
      ],
      hasRtc: true,
    },
    zoneId: 'zone-greenhouse',
    deviceCount: 0,
    latestReadingAt: null,
  };
}

export function buildReading(now: Date): Reading {
  return {
    id: 'reading-1',
    nodeId: NODE_SLUG,
    sensorId: SENSOR_ID,
    temperature: 21.4,
    humidity: 58,
    co2: 812,
    createdAt: now.toISOString(),
  };
}

export function buildSystemStatus(now: Date): SystemStatus {
  return {
    at: now.toISOString(),
    sensorStale: false,
    staleRoles: [],
    nodesOnline: 1,
    nodesTotal: 1,
    nodesPending: 0,
    isLeading: true,
    lastEvaluationAt: null,
    sentAt: now.toISOString(),
  };
}

export function buildZone(): Zone {
  return {
    id: 'zone-greenhouse',
    slug: 'greenhouse',
    displayName: ZONE_DISPLAY_NAME,
    updatedAt: '2026-11-01T00:00:00.000Z',
    rulesConfig: {
      enabledRoles: [],
      sensorPolicy: { default: { source: 'mean', maxAgeMs: 120_000 } },
      rules: {},
      timezone: 'America/Vancouver',
    },
  };
}

export function buildEmptyDayNightStats(): DayNightStats {
  return {
    periods: [],
    nextBoundary: null,
    daylight: {
      startTime: '06:30',
      endTime: '18:30',
      timezone: 'America/Vancouver',
    },
  };
}

export function buildEmptyZoneHistory(): ZoneHistoryReport {
  return {
    from: '2026-11-01T00:00:00.000Z',
    to: '2026-11-02T00:00:00.000Z',
    zones: [{ zoneId: buildZone().id, probes: [], devices: [] }],
  };
}
