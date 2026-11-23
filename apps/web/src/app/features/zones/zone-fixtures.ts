import {
  DeviceRole,
  NodeKind,
  NodeStatus,
  type Device,
  type Node,
  type Reading,
  type RulesCycle,
  type RulesEvaluation,
  type ZoneFailure,
  type Zone,
} from '@tempestas/domain';
import { MILLISECONDS_PER_SECOND } from '../../shared/time';

export const NOW = new Date('2026-11-20T21:14:00.000Z');

export const PUMPHOUSE: Zone = {
  id: 'z-pump',
  slug: 'pumphouse',
  displayName: 'Pumphouse',
  updatedAt: '2026-11-18T06:15:57.000Z',
  rulesConfig: {
    enabledRoles: [DeviceRole.Heater, DeviceRole.HeatTape],
    sensorPolicy: { default: { source: 'min', maxAgeMs: 120_000 } },
    rules: {
      heater: {
        kind: 'thermostat',
        mode: 'heat',
        onAtC: 2,
        offAtC: 5,
        onStale: 'on',
      },
      heat_tape: {
        kind: 'thermostat',
        mode: 'heat',
        onAtC: 4,
        offAtC: 6,
        onStale: 'on',
      },
    },
    timezone: 'America/Vancouver',
  },
};

export const GREENHOUSE: Zone = {
  id: 'z-green',
  slug: 'greenhouse',
  displayName: 'Greenhouse',
  updatedAt: '2026-09-29T21:36:02.000Z',
  rulesConfig: {
    enabledRoles: [DeviceRole.Co2Generator],
    sensorPolicy: { default: { source: 'mean', maxAgeMs: 120_000 } },
    rules: {
      lights: {
        kind: 'daylight-thermostat',
        mode: 'heat',
        onAtC: 26,
        offAtC: 27,
        onStale: 'hold',
      },
      exhaust_fan: {
        kind: 'thermostat',
        mode: 'cool',
        onAtC: 30,
        offAtC: 29.5,
        onStale: 'hold',
      },
      co2_generator: {
        kind: 'co2-burner',
        onStale: 'hold',
        co2OnPpm: 1400,
        co2OffPpm: 1500,
        dayOffAtC: 28,
        nightOnBelowC: 3,
      },
    },
    daylight: { start: '06:30', end: '18:30' },
    timezone: 'America/Vancouver',
  },
};

function secondsBeforeNow(seconds: number): string {
  return new Date(
    NOW.getTime() - seconds * MILLISECONDS_PER_SECOND,
  ).toISOString();
}

export function node(slug: string, zoneId: string | null): Node {
  return {
    id: `n-${slug}`,
    slug,
    displayName: slug,
    location: null,
    kind: NodeKind.RaspberryPi,
    status: NodeStatus.Admitted,
    online: true,
    lastSeenAt: null,
    agentName: null,
    agentVersion: null,
    contractStanding: 'current',
    availableUpdate: null,
    capabilities: {
      contractVersion: 1,
      hasRtc: true,
      sensors: [],
      gpio: { pins: [5, 6], supportsReadback: true },
    },
    zoneId,
    deviceCount: 0,
    latestReadingAt: null,
  };
}

export function probe(
  sensorId: string,
  temperature: number,
  ageSeconds = 4,
  co2: number | null = null,
): Reading {
  return {
    id: `r-${sensorId}`,
    nodeId: 'patji',
    sensorId,
    temperature,
    humidity: null,
    co2,
    createdAt: secondsBeforeNow(ageSeconds),
  };
}

export function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'd-heater',
    nodeId: 'patji',
    zoneId: 'z-pump',
    name: 'Heater',
    description: null,
    gpio: 5,
    onDelayDuration: 300,
    onAt: null,
    offAt: null,
    onLevel: 1,
    rulesEnabled: true,
    role: DeviceRole.Heater,
    isOn: false,
    canTurnOn: true,
    canTurnOnAt: null,
    ...overrides,
  };
}

export function heatTape(overrides: Partial<Device> = {}): Device {
  return device({
    id: 'd-tape',
    name: 'Heat tape',
    gpio: 6,
    role: DeviceRole.HeatTape,
    ...overrides,
  });
}

export function pumphouseEvaluation(
  overrides: Partial<RulesEvaluation> = {},
): RulesEvaluation {
  const climate = {
    temperatureC: 17.5,
    co2Ppm: null,
    observedAt: NOW.toISOString(),
    sourceNodeIds: ['patji'],
    sourceSensorIds: ['patji/air', 'patji/pipes'],
    decidingSensorIds: ['patji/pipes'],
    co2DecidingSensorIds: [],
  };
  return {
    zoneId: 'z-pump',
    zoneSlug: 'pumphouse',
    evaluatedAt: secondsBeforeNow(3),
    minutesSinceMidnightLocal: 854,
    localTime: '14:14',
    timezone: 'America/Vancouver',
    enabledRoles: [DeviceRole.Heater, DeviceRole.HeatTape],
    climateByRole: { heater: climate, heat_tape: climate },
    staleRoles: [],
    decisions: [
      {
        role: DeviceRole.Heater,
        desired: 'off',
        reason: 'temp-above-setpoint',
        sourceNodeIds: ['patji'],
        dispatched: [
          {
            deviceId: 'd-heater',
            deviceName: 'Heater',
            outcome: 'already-in-state',
          },
        ],
      },
      {
        role: DeviceRole.HeatTape,
        desired: 'off',
        reason: 'temp-above-setpoint',
        sourceNodeIds: ['patji'],
        dispatched: [],
      },
    ],
    ...overrides,
  };
}

export function cycleOf(
  evaluations: RulesEvaluation[],
  failingZones: ZoneFailure[] = [],
): RulesCycle {
  return { at: NOW.toISOString(), evaluations, failingZones };
}

export const PUMPHOUSE_REFUSED = cycleOf(
  [],
  [{ zoneSlug: 'pumphouse', reason: 'invalid rules_config' }],
);
