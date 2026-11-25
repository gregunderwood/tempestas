import {
  type DeviceRole,
  type ClimateSample,
  type SensorPolicy,
  type ZoneRulesConfig,
  sensorKey,
} from '@tempestas/domain';
import { ROLE_ORDER } from './rules.engine';

type SensorSource = SensorPolicy['source'];

export interface ProbeTemperature {
  nodeId: string;
  sensorId: string;
  temperatureC: number;
}

const NODE_SOURCE_PREFIX = 'node:';
const SENSOR_SOURCE_PREFIX = 'sensor:';

export interface NodeSample {
  nodeId: string;
  sensorId: string;
  temperatureC: number;
  // Null is a reading the node reported as invalid, never zero.
  co2Ppm: number | null;
  observedAt: Date;
}

export interface ResolvedClimate {
  climateByRole: Partial<Record<DeviceRole, ClimateSample>>;
  // Roles that had a sensor and lost it, kept apart from absent roles so the dashboard can raise its banner.
  staleRoles: DeviceRole[];
}

// Pure: `now` is a parameter. The sources are described in docs/Rules and Climate.md.
export function resolveClimate(
  samples: readonly NodeSample[],
  config: ZoneRulesConfig,
  now: Date,
): ResolvedClimate {
  const climateByRole: Partial<Record<DeviceRole, ClimateSample>> = {};
  const staleRoles: DeviceRole[] = [];

  // Every role with a rule, owned or not, so last-evaluation shows what an unowned role would have seen.
  const roles = ROLE_ORDER.filter((role) => config.rules[role] !== undefined);

  for (const role of roles) {
    const policy = config.rules[role]?.sensor ?? config.sensorPolicy.default;
    const candidates = selectSource(samples, policy.source);

    if (candidates.length === 0) {
      continue;
    }

    const fresh = keepFresh(candidates, policy.maxAgeMs, now);
    if (fresh.length === 0) {
      // Carry the last sample so the UI can say how old it is and which node went quiet.
      staleRoles.push(role);
      climateByRole[role] = aggregate(candidates, policy.source);
      continue;
    }

    climateByRole[role] = aggregate(fresh, policy.source);
  }

  return { climateByRole, staleRoles };
}

function keepFresh(
  candidates: NodeSample[],
  maxAgeMs: number | undefined,
  now: Date,
): NodeSample[] {
  if (maxAgeMs === undefined) {
    return candidates;
  }
  return candidates.filter(
    (sample) => now.getTime() - sample.observedAt.getTime() <= maxAgeMs,
  );
}

// Null when the source names no probe among those given.
export function pickSourceTemperature(
  probes: readonly ProbeTemperature[],
  source: SensorSource,
): number | null {
  const candidates = selectSource(probes, source);
  if (candidates.length === 0) return null;
  return pickBySource(
    candidates.map((probe) => probe.temperatureC),
    source,
  );
}

function selectSource<Probe extends { nodeId: string; sensorId: string }>(
  samples: readonly Probe[],
  source: SensorSource,
): Probe[] {
  if (source.startsWith(NODE_SOURCE_PREFIX)) {
    const slug = source.slice(NODE_SOURCE_PREFIX.length);
    return samples.filter((sample) => sample.nodeId === slug);
  }
  if (source.startsWith(SENSOR_SOURCE_PREFIX)) {
    const key = source.slice(SENSOR_SOURCE_PREFIX.length);
    return samples.filter((sample) => sensorKey(sample) === key);
  }
  return [...samples];
}

function aggregate(samples: NodeSample[], source: SensorSource): ClimateSample {
  const pickedTemperature = pickBySource(
    samples.map((sample) => sample.temperatureC),
    source,
  );
  // Nulls are dropped, not propagated: one broken sensor must not blind the zone.
  const samplesWithValidCo2 = samples.filter(
    (sample): sample is NodeSample & { co2Ppm: number } =>
      sample.co2Ppm !== null,
  );
  const pickedCo2 =
    samplesWithValidCo2.length === 0
      ? null
      : pickBySource(
          samplesWithValidCo2.map((sample) => sample.co2Ppm),
          source,
        );

  return {
    temperatureC: roundToHundredths(pickedTemperature),
    co2Ppm: pickedCo2 === null ? null : Math.round(pickedCo2),
    // The oldest input, so provenance cannot look fresher than what it was computed from.
    observedAt: new Date(
      Math.min(...samples.map((sample) => sample.observedAt.getTime())),
    ).toISOString(),
    sourceNodeIds: [...new Set(samples.map((sample) => sample.nodeId))],
    sourceSensorIds: samples.map(sensorKey),
    decidingSensorIds: findDecidingSensorIds(
      samples,
      source,
      (sample) => sample.temperatureC === pickedTemperature,
    ),
    co2DecidingSensorIds: findDecidingSensorIds(
      samplesWithValidCo2,
      source,
      (sample) => sample.co2Ppm === pickedCo2,
    ),
  };
}

function findDecidingSensorIds(
  samples: NodeSample[],
  source: SensorSource,
  holdsPickedValue: (sample: NodeSample) => boolean,
): string[] {
  const picksOneSample = source === 'min' || source === 'max';
  const deciding = picksOneSample ? samples.filter(holdsPickedValue) : samples;
  return deciding.map(sensorKey);
}

function pickBySource(values: number[], source: SensorSource): number {
  switch (source) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    // A node: or sensor: source is already narrowed, so the mean of what is left.
    default:
      return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
}

function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}
