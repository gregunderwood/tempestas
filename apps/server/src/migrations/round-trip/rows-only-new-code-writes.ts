import {
  AddCo2DeadBand1789087500000,
  AddDeviceInputBtuPerHour1795488489699,
  AddHeatingRoles1794976900000,
  AddNodeAgentName1795330000000,
  AddNodeBootId1788923106173,
  AddPicoNodeKind1795220722652,
  AddPinTransitions1789170000000,
  HumidityIsOptional1794977000000,
  InitialSchema1788917132521,
  RuleKindsPerRole1794975900000,
  ScopeReadingDedupeToBoot1788925934987,
} from '..';
import {
  DEVICE_ID,
  NODE_ID,
  ZONE_ID,
  type Statement,
} from './rows-added-after';

export type RevertOverNewRows =
  { outcome: 'reverts' } | { outcome: 'refuses'; namingThem: RegExp };

export interface RowsOnlyNewCodeWrites {
  statements: Statement[];
  revert: RevertOverNewRows;
}

const REVERTS: RevertOverNewRows = { outcome: 'reverts' };

const PUMPHOUSE_RULES = {
  enabledRoles: ['heater', 'heat_tape'],
  sensorPolicy: { default: { source: 'zone-average', maxAgeMs: 600_000 } },
  rules: {
    heater: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 3,
      offAtC: 6,
      onStale: 'on',
    },
  },
  timezone: 'America/Edmonton',
};

export const ROWS_ONLY_NEW_CODE_WRITES = new Map<string, RowsOnlyNewCodeWrites>(
  [
    [
      InitialSchema1788917132521.name,
      {
        statements: [
          {
            sql: `INSERT INTO zones (slug, display_name, rules_config) VALUES ($1, $2, $3)`,
            parameters: ['bench', 'Bench', {}],
          },
        ],
        revert: REVERTS,
      },
    ],
    [
      AddNodeBootId1788923106173.name,
      {
        statements: [
          {
            sql: `UPDATE nodes SET boot_id = $1 WHERE id = $2`,
            parameters: ['boot-2', NODE_ID],
          },
        ],
        revert: REVERTS,
      },
    ],
    [
      ScopeReadingDedupeToBoot1788925934987.name,
      {
        statements: [
          {
            sql: `INSERT INTO sensor_readings (node_id, sensor_id, temperature, humidity, node_seq, boot_id)
                    VALUES ($1, $2, $3, $4, $5, $6)`,
            parameters: [NODE_ID, 'scd4x-0', 20, 50, 1, 'boot-2'],
          },
        ],
        revert: {
          outcome: 'refuses',
          namingThem: /Sequence numbers repeated: 1\./,
        },
      },
    ],
    [
      AddCo2DeadBand1789087500000.name,
      {
        statements: [
          {
            sql: `UPDATE zones SET rules_config = jsonb_set(jsonb_set(rules_config,
                    '{thresholds,co2OnPpm}', '1300'), '{thresholds,co2OffPpm}', '1600')
                  WHERE id = $1`,
            parameters: [ZONE_ID],
          },
        ],
        revert: REVERTS,
      },
    ],
    [
      AddPinTransitions1789170000000.name,
      {
        statements: [
          {
            sql: `INSERT INTO pin_transitions (node_id, pin, known, reason, observed_at)
                    VALUES ($1, $2, $3, $4, $5)`,
            parameters: ['elantris', 20, true, 'boot', '2026-01-11T00:00:00Z'],
          },
        ],
        revert: REVERTS,
      },
    ],
    [
      RuleKindsPerRole1794975900000.name,
      {
        statements: [
          {
            sql: `INSERT INTO zones (slug, display_name, rules_config) VALUES ($1, $2, $3)`,
            parameters: ['pumphouse', 'Pumphouse', PUMPHOUSE_RULES],
          },
        ],
        revert: { outcome: 'refuses', namingThem: /Zone "pumphouse"/ },
      },
    ],
    [
      AddHeatingRoles1794976900000.name,
      {
        statements: [
          {
            sql: `INSERT INTO devices (node_id, zone_id, name, gpio, role) VALUES ($1, $2, $3, $4, $5)`,
            parameters: [NODE_ID, ZONE_ID, 'Pumphouse heater', 20, 'heater'],
          },
        ],
        revert: { outcome: 'refuses', namingThem: /Pumphouse heater/ },
      },
    ],
    [
      HumidityIsOptional1794977000000.name,
      {
        statements: [
          {
            sql: `INSERT INTO sensor_readings (node_id, sensor_id, temperature, humidity, node_seq, boot_id)
                    VALUES ($1, $2, $3, NULL, $4, $5)`,
            parameters: [NODE_ID, 'ds18b20-0', 2.5, 1, 'boot-1'],
          },
        ],
        revert: {
          outcome: 'refuses',
          namingThem: /Readings without humidity: 1\./,
        },
      },
    ],
    [
      AddPicoNodeKind1795220722652.name,
      {
        statements: [
          {
            sql: `INSERT INTO nodes (slug, display_name, kind, capabilities) VALUES ($1, $2, $3, $4)`,
            parameters: ['braize', 'Braize', 'pico', { contractVersion: 1 }],
          },
        ],
        revert: { outcome: 'refuses', namingThem: /braize/ },
      },
    ],
    [
      AddNodeAgentName1795330000000.name,
      {
        statements: [
          {
            sql: `UPDATE nodes SET agent_name = $1 WHERE id = $2`,
            parameters: ['agent-linux', NODE_ID],
          },
        ],
        revert: REVERTS,
      },
    ],
    [
      AddDeviceInputBtuPerHour1795488489699.name,
      {
        statements: [
          {
            sql: `UPDATE devices SET input_btu_per_hour = $1 WHERE id = $2`,
            parameters: [40_000, DEVICE_ID],
          },
        ],
        revert: REVERTS,
      },
    ],
  ],
);
