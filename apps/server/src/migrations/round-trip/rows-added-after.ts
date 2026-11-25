import type { DataSource } from 'typeorm';
import {
  AddNodeUpdates1795546658688,
  AddPinTransitions1789170000000,
  InitialSchema1788917132521,
} from '..';

export const ZONE_ID = '00000000-0000-4000-8000-000000000001';
export const NODE_ID = '00000000-0000-4000-8000-000000000002';
export const DEVICE_ID = '00000000-0000-4000-8000-000000000003';
const READING_ID = '00000000-0000-4000-8000-000000000004';
const PIN_TRANSITION_ID = '00000000-0000-4000-8000-000000000005';
const NODE_UPDATE_ID = '00000000-0000-4000-8000-000000000006';

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

export interface Statement {
  sql: string;
  parameters: unknown[];
}

// One row per table: the dump compares rows in storage order, which an UPDATE of several can shuffle.
export const ROWS_ADDED_AFTER = new Map<string, Statement[]>([
  [
    InitialSchema1788917132521.name,
    [
      {
        sql: `INSERT INTO zones (id, slug, display_name, rules_config) VALUES ($1, $2, $3, $4)`,
        parameters: [
          ZONE_ID,
          'greenhouse',
          'Greenhouse',
          GREENHOUSE_RULES_BEFORE_DEAD_BAND,
        ],
      },
      {
        sql: `INSERT INTO nodes (id, slug, display_name, kind, status, capabilities, agent_version, zone_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        parameters: [
          NODE_ID,
          'elantris',
          'Elantris',
          'rpi',
          'admitted',
          { contractVersion: 1 },
          '1.0.0',
          ZONE_ID,
        ],
      },
      {
        sql: `INSERT INTO devices (id, node_id, zone_id, name, gpio, role) VALUES ($1, $2, $3, $4, $5, $6)`,
        parameters: [
          DEVICE_ID,
          NODE_ID,
          ZONE_ID,
          "Greg's bench lights",
          16,
          'lights',
        ],
      },
      {
        sql: `INSERT INTO sensor_readings (id, node_id, sensor_id, temperature, humidity, co2, node_seq, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        parameters: [
          READING_ID,
          NODE_ID,
          'scd4x-0',
          21.5,
          55,
          1200,
          1,
          '2026-01-10T12:00:00Z',
        ],
      },
    ],
  ],
  [
    AddPinTransitions1789170000000.name,
    [
      {
        sql: `INSERT INTO pin_transitions (id, node_id, pin, level, known, energised, device_id, role, reason, observed_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        parameters: [
          PIN_TRANSITION_ID,
          'elantris',
          16,
          1,
          true,
          true,
          DEVICE_ID,
          'lights',
          'rules',
          '2026-01-10T12:00:00Z',
        ],
      },
    ],
  ],
  [
    AddNodeUpdates1795546658688.name,
    [
      {
        sql: `INSERT INTO node_updates (id, node_id, app, from_version, to_version, is_roll_back, last_state, outcome, started_at, last_heard_at, finished_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        parameters: [
          NODE_UPDATE_ID,
          NODE_ID,
          'agent-linux',
          '1.1.0',
          '1.1.1',
          false,
          'healthy',
          'healthy',
          '2026-11-24T12:00:00Z',
          '2026-11-24T12:01:00Z',
          '2026-11-24T12:01:00Z',
        ],
      },
    ],
  ],
]);

export async function runStatements(
  statements: Statement[],
  source: DataSource,
) {
  for (const { sql, parameters } of statements) {
    await source.query(sql, parameters);
  }
}

export async function addRowsAfter(migrationName: string, source: DataSource) {
  await runStatements(ROWS_ADDED_AFTER.get(migrationName) ?? [], source);
}
