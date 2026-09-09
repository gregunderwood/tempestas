import {
  DeviceRole,
  type ClimateSample,
  type SensorPolicy,
  type ZoneRulesConfig,
} from '@tempestas/domain';

/**
 * Turns "one latest reading per node" into "the climate each role is evaluated
 * against", by applying the zone's sensor policy.
 *
 * This is the part that makes cross-node rules work without a rule engine. The
 * greenhouse has sensors at each end; the burner cares about the reading at its
 * own end, while the exhaust fan should vent when the *hottest* end is hot. That
 * is a per-role choice over the same set of samples, expressed as data:
 *
 *     mean | max | min | node:<slug>
 *
 * Four options, deliberately - not a predicate language.
 *
 * Pure: `now` is a parameter, never `new Date()`.
 */

export interface NodeSample {
  nodeId: string;
  temperatureC: number;
  /** Null means the node reported an INVALID reading, not a zero one. */
  co2Ppm: number | null;
  observedAt: Date;
}

export interface ResolvedClimate {
  climateByRole: Partial<Record<DeviceRole, ClimateSample>>;
  /**
   * Roles that had a sensor and lost it. Distinguished from an absent role so
   * the dashboard can raise the loud, persistent banner that makes "hold last
   * state" a sound policy rather than a silent stall.
   */
  staleRoles: DeviceRole[];
}

const RESOLVED_ROLES: readonly DeviceRole[] = [
  DeviceRole.Lights,
  DeviceRole.Co2Generator,
  DeviceRole.ExhaustFan,
];

export function resolveClimate(
  samples: readonly NodeSample[],
  config: ZoneRulesConfig,
  now: Date,
): ResolvedClimate {
  const climateByRole: Partial<Record<DeviceRole, ClimateSample>> = {};
  const staleRoles: DeviceRole[] = [];

  for (const role of RESOLVED_ROLES) {
    const policy =
      config.sensorPolicy.byRole?.[role] ?? config.sensorPolicy.default;
    const candidates = selectSource(samples, policy.source);

    if (candidates.length === 0) {
      // No sensor is configured or reachable for this role at all: a
      // configuration gap, not an incident.
      continue;
    }

    const fresh =
      policy.maxAgeMs === undefined
        ? candidates
        : candidates.filter(
            (s) => now.getTime() - s.observedAt.getTime() <= policy.maxAgeMs!,
          );

    if (fresh.length === 0) {
      // The sensors exist and have gone quiet. Carry the last sample so the UI
      // can say how old it is and which node stopped reporting.
      staleRoles.push(role);
      climateByRole[role] = aggregate(candidates, policy.source);
      continue;
    }

    climateByRole[role] = aggregate(fresh, policy.source);
  }

  return { climateByRole, staleRoles };
}

function selectSource(
  samples: readonly NodeSample[],
  source: SensorPolicy['source'],
): NodeSample[] {
  if (source.startsWith('node:')) {
    const slug = source.slice('node:'.length);
    return samples.filter((s) => s.nodeId === slug);
  }
  return [...samples];
}

function aggregate(
  samples: NodeSample[],
  source: SensorPolicy['source'],
): ClimateSample {
  const temperatures = samples.map((s) => s.temperatureC);
  // Nulls are excluded rather than propagated: one broken sensor beside a
  // working one should not blind the zone. Null survives only when NO node has
  // a valid reading, which is the case the burner rule fails safe on.
  const co2s = samples
    .map((s) => s.co2Ppm)
    .filter((v): v is number => v !== null);

  return {
    temperatureC: round2(pick(temperatures, source)),
    co2Ppm: co2s.length === 0 ? null : Math.round(pick(co2s, source)),
    // The oldest contributing sample, so provenance cannot look fresher than
    // the weakest input it was computed from.
    observedAt: new Date(
      Math.min(...samples.map((s) => s.observedAt.getTime())),
    ).toISOString(),
    sourceNodeIds: samples.map((s) => s.nodeId),
  };
}

function pick(values: number[], source: SensorPolicy['source']): number {
  switch (source) {
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    // `mean`, and every `node:<slug>` source - which has already been narrowed
    // to a single sample, so its mean is that sample.
    default:
      return values.reduce((sum, v) => sum + v, 0) / values.length;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
