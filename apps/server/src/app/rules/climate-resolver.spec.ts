import {
  DeviceRole,
  type SensorPolicy,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { resolveClimate, type NodeSample } from './climate-resolver';

const NOW = new Date('2026-01-10T12:00:00Z');
const FRESH = new Date('2026-01-10T11:59:30Z'); // 30s old
const OLD = new Date('2026-01-10T11:50:00Z'); //  10min old

// The greenhouse's three roles; `byRole` lands on each rule's own `sensor` override.
function config(
  defaultPolicy: SensorPolicy,
  byRole: Partial<Record<DeviceRole, SensorPolicy>> = {},
): ZoneRulesConfig {
  const sensor = (role: DeviceRole): { sensor?: SensorPolicy } =>
    byRole[role] ? { sensor: byRole[role] } : {};
  return {
    enabledRoles: [
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ],
    sensorPolicy: { default: defaultPolicy },
    daylight: { start: '06:30', end: '18:30' },
    rules: {
      [DeviceRole.Lights]: {
        kind: 'daylight-thermostat',
        mode: 'heat',
        onAtC: 26,
        offAtC: 27,
        onStale: 'hold',
        ...sensor(DeviceRole.Lights),
      },
      [DeviceRole.Co2Generator]: {
        kind: 'co2-burner',
        dayOffAtC: 26,
        nightOnBelowC: 3,
        co2OnPpm: 1400,
        co2OffPpm: 1500,
        onStale: 'hold',
        ...sensor(DeviceRole.Co2Generator),
      },
      [DeviceRole.ExhaustFan]: {
        kind: 'thermostat',
        mode: 'cool',
        onAtC: 30,
        offAtC: 29.5,
        onStale: 'hold',
        ...sensor(DeviceRole.ExhaustFan),
      },
    },
    timezone: 'America/Vancouver',
  };
}

function bothEnds(observedAt = FRESH): NodeSample[] {
  return [
    {
      nodeId: 'elantris',
      sensorId: 's',
      temperatureC: 20,
      co2Ppm: 500,
      observedAt,
    },
    {
      nodeId: 'north-end',
      sensorId: 's',
      temperatureC: 24,
      co2Ppm: 700,
      observedAt,
    },
  ];
}

describe('sensor sources', () => {
  it('means across every node by default', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(),
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 22,
      co2Ppm: 600,
    });
  });

  // The exhaust fan should vent when the HOTTEST end is hot.
  it('takes the max when asked', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(),
      config({ source: 'max' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.ExhaustFan]).toMatchObject({
      temperatureC: 24,
      co2Ppm: 700,
    });
  });

  it('takes the min when asked', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(),
      config({ source: 'min' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 20,
      co2Ppm: 500,
    });
  });

  // The burner cares about the reading at its own end of the greenhouse.
  it('pins a role to one node with node:<slug>', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(),
      config(
        { source: 'mean' },
        { [DeviceRole.Co2Generator]: { source: 'node:elantris' } },
      ),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      temperatureC: 20,
      sourceNodeIds: ['elantris'],
    });
    // Everything else still means across both.
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 22,
    });
  });

  it('leaves a role unresolved when its pinned node has no reading', () => {
    const { climateByRole, staleRoles } = resolveClimate(
      bothEnds(),
      config(
        { source: 'mean' },
        { [DeviceRole.Co2Generator]: { source: 'node:missing' } },
      ),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toBeUndefined();
    // Absent is a configuration gap, not an incident - so not stale either.
    expect(staleRoles).toEqual([]);
  });

  it('records which nodes actually contributed', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(),
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]?.sourceNodeIds).toEqual([
      'elantris',
      'north-end',
    ]);
  });

  it('reports the OLDEST contributing sample, so provenance cannot look too fresh', () => {
    const samples: NodeSample[] = [
      {
        nodeId: 'elantris',
        sensorId: 's',
        temperatureC: 20,
        co2Ppm: 500,
        observedAt: FRESH,
      },
      {
        nodeId: 'north-end',
        sensorId: 's',
        temperatureC: 24,
        co2Ppm: 700,
        observedAt: OLD,
      },
    ];
    const { climateByRole } = resolveClimate(
      samples,
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]?.observedAt).toBe(
      OLD.toISOString(),
    );
  });

  it('rounds temperature to two places and CO2 to an integer', () => {
    const samples: NodeSample[] = [
      {
        nodeId: 'a',
        sensorId: 's',
        temperatureC: 20.005,
        co2Ppm: 500,
        observedAt: FRESH,
      },
      {
        nodeId: 'b',
        sensorId: 's',
        temperatureC: 20.004,
        co2Ppm: 501,
        observedAt: FRESH,
      },
    ];
    const { climateByRole } = resolveClimate(
      samples,
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 20.0,
      co2Ppm: 501,
    });
  });
});

describe('invalid CO2', () => {
  // One broken sensor beside a working one must not blind the zone.
  it('excludes a null CO2 from the aggregate but keeps the node as a source', () => {
    const samples: NodeSample[] = [
      {
        nodeId: 'elantris',
        sensorId: 's',
        temperatureC: 20,
        co2Ppm: null,
        observedAt: FRESH,
      },
      {
        nodeId: 'north-end',
        sensorId: 's',
        temperatureC: 24,
        co2Ppm: 700,
        observedAt: FRESH,
      },
    ];
    const { climateByRole } = resolveClimate(
      samples,
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 22,
      co2Ppm: 700,
      sourceNodeIds: ['elantris', 'north-end'],
    });
  });

  // The case the burner's daytime branch fails safe on.
  it('stays null when no node has a valid CO2', () => {
    const samples: NodeSample[] = [
      {
        nodeId: 'elantris',
        sensorId: 's',
        temperatureC: 20,
        co2Ppm: null,
        observedAt: FRESH,
      },
      {
        nodeId: 'north-end',
        sensorId: 's',
        temperatureC: 24,
        co2Ppm: null,
        observedAt: FRESH,
      },
    ];
    const { climateByRole } = resolveClimate(
      samples,
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]?.co2Ppm).toBeNull();
  });
});

describe('deciding sensors per measurement', () => {
  // The coldest end is not the end with the least CO2.
  function crossedEnds(): NodeSample[] {
    return [
      {
        nodeId: 'elantris',
        sensorId: 's',
        temperatureC: 20,
        co2Ppm: 900,
        observedAt: FRESH,
      },
      {
        nodeId: 'north-end',
        sensorId: 's',
        temperatureC: 24,
        co2Ppm: 600,
        observedAt: FRESH,
      },
    ];
  }

  it('names the probe that decided CO2 apart from the one that decided temperature', () => {
    const { climateByRole } = resolveClimate(
      crossedEnds(),
      config({ source: 'min' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      temperatureC: 20,
      co2Ppm: 600,
      decidingSensorIds: ['elantris/s'],
      co2DecidingSensorIds: ['north-end/s'],
    });
  });

  it('takes the max of each measurement from its own probe', () => {
    const { climateByRole } = resolveClimate(
      crossedEnds(),
      config({ source: 'max' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      temperatureC: 24,
      co2Ppm: 900,
      decidingSensorIds: ['north-end/s'],
      co2DecidingSensorIds: ['elantris/s'],
    });
  });

  it('never names a probe with no valid CO2 as deciding CO2', () => {
    const [elantris, northEnd] = crossedEnds();
    const { climateByRole } = resolveClimate(
      [{ ...elantris, co2Ppm: null }, northEnd],
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      decidingSensorIds: ['elantris/s', 'north-end/s'],
      co2DecidingSensorIds: ['north-end/s'],
    });
  });

  it('names no CO2 probe when none has a valid reading', () => {
    const noCo2 = crossedEnds().map((sample) => ({ ...sample, co2Ppm: null }));
    const { climateByRole } = resolveClimate(
      noCo2,
      config({ source: 'min' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]).toMatchObject({
      co2Ppm: null,
      co2DecidingSensorIds: [],
    });
  });

  it('names both probes when they tie for the lowest CO2', () => {
    const tied = crossedEnds().map((sample) => ({ ...sample, co2Ppm: 600 }));
    const { climateByRole } = resolveClimate(
      tied,
      config({ source: 'min' }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Co2Generator]?.co2DecidingSensorIds).toEqual(
      ['elantris/s', 'north-end/s'],
    );
  });
});

describe('staleness', () => {
  it('marks a role stale when every sample is older than maxAgeMs', () => {
    const { staleRoles } = resolveClimate(
      bothEnds(OLD),
      config({ source: 'mean', maxAgeMs: 120_000 }),
      NOW,
    );
    expect(staleRoles).toEqual([
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ]);
  });

  // Holding last state needs the last state, and the UI shows how old it is.
  it('still carries the last known climate for a stale role', () => {
    const { climateByRole } = resolveClimate(
      bothEnds(OLD),
      config({ source: 'mean', maxAgeMs: 120_000 }),
      NOW,
    );
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 22,
      observedAt: OLD.toISOString(),
    });
  });

  it('uses only the fresh nodes when one has gone quiet', () => {
    const samples: NodeSample[] = [
      {
        nodeId: 'elantris',
        sensorId: 's',
        temperatureC: 20,
        co2Ppm: 500,
        observedAt: FRESH,
      },
      {
        nodeId: 'north-end',
        sensorId: 's',
        temperatureC: 24,
        co2Ppm: 700,
        observedAt: OLD,
      },
    ];
    const { climateByRole, staleRoles } = resolveClimate(
      samples,
      config({ source: 'mean', maxAgeMs: 120_000 }),
      NOW,
    );
    expect(staleRoles).toEqual([]);
    expect(climateByRole[DeviceRole.Lights]).toMatchObject({
      temperatureC: 20,
      sourceNodeIds: ['elantris'],
    });
  });

  it('accepts a sample exactly at maxAgeMs', () => {
    const exactly = new Date(NOW.getTime() - 120_000);
    const { staleRoles } = resolveClimate(
      bothEnds(exactly),
      config({ source: 'mean', maxAgeMs: 120_000 }),
      NOW,
    );
    expect(staleRoles).toEqual([]);
  });

  it('never goes stale when no maxAgeMs is configured', () => {
    const ancient = new Date('2020-01-01T00:00:00Z');
    const { staleRoles, climateByRole } = resolveClimate(
      bothEnds(ancient),
      config({ source: 'mean' }),
      NOW,
    );
    expect(staleRoles).toEqual([]);
    expect(climateByRole[DeviceRole.Lights]).toBeDefined();
  });
});

describe('no sensors at all', () => {
  it('resolves nothing and reports nothing stale', () => {
    const { climateByRole, staleRoles } = resolveClimate(
      [],
      config({ source: 'mean' }),
      NOW,
    );
    expect(climateByRole).toEqual({});
    expect(staleRoles).toEqual([]);
  });
});

describe('which roles are resolved', () => {
  // A pumphouse has no lights to resolve, and a heater the old fixed list did not know.
  it('resolves exactly the roles the zone has rules for', () => {
    const pumphouse: ZoneRulesConfig = {
      enabledRoles: [DeviceRole.Heater],
      sensorPolicy: { default: { source: 'min' } },
      rules: {
        [DeviceRole.Heater]: {
          kind: 'thermostat',
          mode: 'heat',
          onAtC: 2,
          offAtC: 5,
          onStale: 'on',
        },
      },
      timezone: 'America/Vancouver',
    };
    const { climateByRole } = resolveClimate(bothEnds(), pumphouse, NOW);
    expect(Object.keys(climateByRole)).toEqual([DeviceRole.Heater]);
    expect(climateByRole[DeviceRole.Heater]).toMatchObject({
      temperatureC: 20,
    });
  });
});

describe('role order', () => {
  // Postgres returns jsonb keys shortest-first, so the written order is gone.
  it('resolves in the fixed role order, not the order of the rules object', () => {
    const base = config({ source: 'mean', maxAgeMs: 60_000 });
    const reordered: ZoneRulesConfig = {
      ...base,
      rules: {
        [DeviceRole.ExhaustFan]: base.rules[DeviceRole.ExhaustFan],
        [DeviceRole.Lights]: base.rules[DeviceRole.Lights],
        [DeviceRole.Co2Generator]: base.rules[DeviceRole.Co2Generator],
      },
    };
    const { staleRoles } = resolveClimate(bothEnds(OLD), reordered, NOW);
    expect(staleRoles).toEqual([
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ]);
  });
});

describe('several sensors on one node - the pumphouse', () => {
  const pumphouse: ZoneRulesConfig = {
    enabledRoles: [DeviceRole.HeatTape],
    sensorPolicy: { default: { source: 'min', maxAgeMs: 60_000 } },
    rules: {
      [DeviceRole.HeatTape]: {
        kind: 'thermostat',
        mode: 'heat',
        onAtC: 4,
        offAtC: 6,
        onStale: 'on',
      },
    },
    timezone: 'America/Vancouver',
  };

  function probes(pipesAt = FRESH): NodeSample[] {
    return [
      {
        nodeId: 'pumphouse',
        sensorId: 'air',
        temperatureC: 7,
        co2Ppm: null,
        observedAt: FRESH,
      },
      {
        nodeId: 'pumphouse',
        sensorId: 'pipes',
        temperatureC: 1.5,
        co2Ppm: null,
        observedAt: pipesAt,
      },
    ];
  }

  // Averaged or overwritten inside its node, the cold pipe would leave the tape off at 1.5 °C.
  it('takes the coldest PROBE, not one per node', () => {
    const { climateByRole } = resolveClimate(probes(), pumphouse, NOW);
    expect(climateByRole[DeviceRole.HeatTape]).toMatchObject({
      temperatureC: 1.5,
      sourceSensorIds: ['pumphouse/air', 'pumphouse/pipes'],
    });
  });

  it('names the probe that decided, not only the probes that took part', () => {
    const { climateByRole } = resolveClimate(probes(), pumphouse, NOW);
    expect(climateByRole[DeviceRole.HeatTape]?.decidingSensorIds).toEqual([
      'pumphouse/pipes',
    ]);
  });

  it('names both probes when they tie for the coldest', () => {
    const tied = probes().map((probe) => ({ ...probe, temperatureC: 1.5 }));
    const { climateByRole } = resolveClimate(tied, pumphouse, NOW);
    expect(climateByRole[DeviceRole.HeatTape]?.decidingSensorIds).toEqual([
      'pumphouse/air',
      'pumphouse/pipes',
    ]);
  });

  it('names every contributor as deciding a mean', () => {
    const averaged: ZoneRulesConfig = {
      ...pumphouse,
      sensorPolicy: { default: { source: 'mean' } },
    };
    const { climateByRole } = resolveClimate(probes(), averaged, NOW);
    expect(climateByRole[DeviceRole.HeatTape]?.decidingSensorIds).toEqual([
      'pumphouse/air',
      'pumphouse/pipes',
    ]);
  });

  it('names the node once, however many of its probes contributed', () => {
    const { climateByRole } = resolveClimate(probes(), pumphouse, NOW);
    expect(climateByRole[DeviceRole.HeatTape]?.sourceNodeIds).toEqual([
      'pumphouse',
    ]);
  });

  it('pins a role to one probe with sensor:<slug>/<id>', () => {
    const pinned: ZoneRulesConfig = {
      ...pumphouse,
      sensorPolicy: { default: { source: 'sensor:pumphouse/air' } },
    };
    const { climateByRole } = resolveClimate(probes(), pinned, NOW);
    expect(climateByRole[DeviceRole.HeatTape]).toMatchObject({
      temperatureC: 7,
      sourceSensorIds: ['pumphouse/air'],
    });
  });

  // Right, and silent, which is why the health endpoint names the dead probe.
  it('carries on with the remaining probe when one goes quiet', () => {
    const { climateByRole, staleRoles } = resolveClimate(
      probes(OLD),
      pumphouse,
      NOW,
    );
    expect(staleRoles).toEqual([]);
    expect(climateByRole[DeviceRole.HeatTape]).toMatchObject({
      temperatureC: 7,
      sourceSensorIds: ['pumphouse/air'],
    });
  });
});
