import {
  DeviceRole,
  type SensorPolicy,
  type ZoneRulesConfig,
} from '@tempestas/domain';
import { resolveClimate, type NodeSample } from './climate-resolver';

const NOW = new Date('2026-01-10T12:00:00Z');
const FRESH = new Date('2026-01-10T11:59:30Z'); // 30s old
const OLD = new Date('2026-01-10T11:50:00Z'); //  10min old

function config(
  defaultPolicy: SensorPolicy,
  byRole?: Partial<Record<DeviceRole, SensorPolicy>>,
): ZoneRulesConfig {
  return {
    enabledRoles: [
      DeviceRole.Lights,
      DeviceRole.Co2Generator,
      DeviceRole.ExhaustFan,
    ],
    sensorPolicy: { default: defaultPolicy, ...(byRole ? { byRole } : {}) },
    thresholds: {
      startTime: '06:30',
      endTime: '18:30',
      lightsOnTemp: 26,
      lightsOffTemp: 27,
      co2OffTemp: 26,
      co2NightOnTemp: 3,
      exhaustOnTemp: 30,
      exhaustOffTemp: 29.5,
      co2ThresholdPpm: 1500,
    },
    timezone: 'America/Vancouver',
  };
}

/** Two sensors, one at each end of the greenhouse. */
function bothEnds(observedAt = FRESH): NodeSample[] {
  return [
    { nodeId: 'elantris', temperatureC: 20, co2Ppm: 500, observedAt },
    { nodeId: 'north-end', temperatureC: 24, co2Ppm: 700, observedAt },
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
      { nodeId: 'elantris', temperatureC: 20, co2Ppm: 500, observedAt: FRESH },
      { nodeId: 'north-end', temperatureC: 24, co2Ppm: 700, observedAt: OLD },
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
      { nodeId: 'a', temperatureC: 20.005, co2Ppm: 500, observedAt: FRESH },
      { nodeId: 'b', temperatureC: 20.004, co2Ppm: 501, observedAt: FRESH },
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
      { nodeId: 'elantris', temperatureC: 20, co2Ppm: null, observedAt: FRESH },
      { nodeId: 'north-end', temperatureC: 24, co2Ppm: 700, observedAt: FRESH },
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

  // Null survives only when NO node has a valid reading - which is the case the
  // burner's daytime branch fails safe on.
  it('stays null when no node has a valid CO2', () => {
    const samples: NodeSample[] = [
      { nodeId: 'elantris', temperatureC: 20, co2Ppm: null, observedAt: FRESH },
      {
        nodeId: 'north-end',
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

  // "Hold last state" needs the last state to look at, and the UI needs to be
  // able to say how old it is and which node went quiet.
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
      { nodeId: 'elantris', temperatureC: 20, co2Ppm: 500, observedAt: FRESH },
      { nodeId: 'north-end', temperatureC: 24, co2Ppm: 700, observedAt: OLD },
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
