import type { DataSource } from 'typeorm';
import { AddPinTransitions1789170000000, InitialSchema1788917132521 } from '..';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const DEVICE_ID = '00000000-0000-4000-8000-000000000003';

// The greenhouse as it was before the CO2 dead band, so every later down can still express it.
const GREENHOUSE_RULES_BEFORE_DEAD_BAND = {
  enabledRoles: ['lights', 'co2_generator', 'exhaust_fan'],
  sensorPolicy: { default: { source: 'zone-average', maxAgeMs: 120_000 } },
  thresholds: {
    startTime: '06:00',
    endTime: '22:00',
    lightsOnTemp: 18,
    lightsOffTemp: 24,
    co2OffTemp: 28,
    co2NightOnTemp: 8,
    exhaustOnTemp: 30,
    exhaustOffTemp: 27,
    co2ThresholdPpm: 1500,
  },
  timezone: 'America/Edmonton',
};

const ROWS_ADDED_AFTER = new Map<string, string[]>([
  [
    InitialSchema1788917132521.name,
    [
      `INSERT INTO zones (id, slug, display_name, rules_config)
         VALUES ('${ZONE_ID}', 'greenhouse', 'Greenhouse', '${JSON.stringify(GREENHOUSE_RULES_BEFORE_DEAD_BAND)}')`,
      `INSERT INTO nodes (id, slug, display_name, kind, status, capabilities, agent_version, zone_id)
         VALUES ('${NODE_ID}', 'elantris', 'Elantris', 'rpi', 'admitted', '{"contractVersion": 1}', '1.0.0', '${ZONE_ID}')`,
      `INSERT INTO devices (id, node_id, zone_id, name, gpio, role)
         VALUES ('${DEVICE_ID}', '${NODE_ID}', '${ZONE_ID}', 'Lights', 16, 'lights')`,
      `INSERT INTO sensor_readings (id, node_id, sensor_id, temperature, humidity, co2, node_seq, created_at)
         VALUES ('00000000-0000-4000-8000-000000000004', '${NODE_ID}', 'scd4x-0', 21.5, 55, 1200, 1, '2026-01-10T12:00:00Z')`,
    ],
  ],
  [
    AddPinTransitions1789170000000.name,
    [
      `INSERT INTO pin_transitions (id, node_id, pin, level, known, energised, device_id, role, reason, observed_at)
         VALUES ('00000000-0000-4000-8000-000000000005', 'elantris', 16, 1, true, true, '${DEVICE_ID}', 'lights', 'rules', '2026-01-10T12:00:00Z')`,
    ],
  ],
]);

export async function addRowsAfter(migrationName: string, source: DataSource) {
  for (const insert of ROWS_ADDED_AFTER.get(migrationName) ?? []) {
    await source.query(insert);
  }
}
