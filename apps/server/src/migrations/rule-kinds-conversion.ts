/**
 * The pure halves of the RuleKindsPerRole migration, apart from it because the
 * TypeORM CLI instantiates EVERY export of a migration file as a migration -
 * an exported helper there crashes `migration:run` before anything runs.
 *
 * The shapes are declared here rather than imported from the domain library.
 * A migration is a record of a moment; importing today's types would let a
 * later change to them quietly alter what the migration does on a box that has
 * not run it yet.
 */
interface LegacyPolicy {
  source: string;
  maxAgeMs?: number;
}

export interface LegacyConfig {
  enabledRoles: string[];
  sensorPolicy: {
    default: LegacyPolicy;
    byRole?: Record<string, LegacyPolicy>;
  };
  thresholds: {
    startTime: string;
    endTime: string;
    lightsOnTemp: number;
    lightsOffTemp: number;
    co2OffTemp: number;
    co2NightOnTemp: number;
    exhaustOnTemp: number;
    exhaustOffTemp: number;
    co2OnPpm: number;
    co2OffPpm: number;
  };
  timezone: string;
}

export interface KindConfig {
  enabledRoles: string[];
  sensorPolicy: { default: LegacyPolicy };
  rules: Record<string, Record<string, unknown>>;
  daylight?: { start: string; end: string };
  timezone: string;
}

export function toRuleKinds(legacy: LegacyConfig): KindConfig {
  const t = legacy.thresholds;
  const byRole = legacy.sensorPolicy.byRole ?? {};
  // A per-role sensor override moves onto that role's rule.
  const sensor = (role: string): Record<string, unknown> =>
    byRole[role] ? { sensor: byRole[role] } : {};

  return {
    enabledRoles: legacy.enabledRoles,
    sensorPolicy: { default: legacy.sensorPolicy.default },
    daylight: { start: t.startTime, end: t.endTime },
    rules: {
      lights: {
        kind: 'daylight-thermostat',
        mode: 'heat',
        onAtC: t.lightsOnTemp,
        offAtC: t.lightsOffTemp,
        onStale: 'hold',
        ...sensor('lights'),
      },
      co2_generator: {
        kind: 'co2-burner',
        dayOffAtC: t.co2OffTemp,
        nightOnBelowC: t.co2NightOnTemp,
        co2OnPpm: t.co2OnPpm,
        co2OffPpm: t.co2OffPpm,
        onStale: 'hold',
        ...sensor('co2_generator'),
      },
      exhaust_fan: {
        kind: 'thermostat',
        mode: 'cool',
        onAtC: t.exhaustOnTemp,
        offAtC: t.exhaustOffTemp,
        onStale: 'hold',
        ...sensor('exhaust_fan'),
      },
    },
    timezone: legacy.timezone,
  };
}

/** Null when the zone is not the greenhouse shape and cannot go back. */
export function toLegacy(config: KindConfig): LegacyConfig | null {
  const { lights, co2_generator: burner, exhaust_fan: fan } = config.rules;
  const extraRoles = Object.keys(config.rules).filter(
    (role) => !['lights', 'co2_generator', 'exhaust_fan'].includes(role),
  );
  if (
    !config.daylight ||
    lights?.['kind'] !== 'daylight-thermostat' ||
    burner?.['kind'] !== 'co2-burner' ||
    fan?.['kind'] !== 'thermostat' ||
    extraRoles.length > 0
  ) {
    return null;
  }

  const byRole: Record<string, LegacyPolicy> = {};
  for (const [role, rule] of Object.entries(config.rules)) {
    if (rule['sensor']) byRole[role] = rule['sensor'] as LegacyPolicy;
  }

  return {
    enabledRoles: config.enabledRoles,
    sensorPolicy: {
      default: config.sensorPolicy.default,
      ...(Object.keys(byRole).length > 0 ? { byRole } : {}),
    },
    thresholds: {
      startTime: config.daylight.start,
      endTime: config.daylight.end,
      lightsOnTemp: lights['onAtC'] as number,
      lightsOffTemp: lights['offAtC'] as number,
      co2OffTemp: burner['dayOffAtC'] as number,
      co2NightOnTemp: burner['nightOnBelowC'] as number,
      exhaustOnTemp: fan['onAtC'] as number,
      exhaustOffTemp: fan['offAtC'] as number,
      co2OnPpm: burner['co2OnPpm'] as number,
      co2OffPpm: burner['co2OffPpm'] as number,
    },
    timezone: config.timezone,
  };
}
