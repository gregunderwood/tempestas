import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFindFirstRealReadingsSql,
  buildFindProbesSql,
  buildReplaceReadingsSql,
  SEEDED_BOOT_ID,
} from './reading-history-sql.mjs';

const CREATED_AT = new Date('2026-10-24T07:00:00Z');
const PROBE = {
  nodeUuid: '00000000-0000-0000-0000-0000000000aa',
  nodeId: 'sim-pi',
  sensorId: 'scd4x-0',
};

function readingRow(overrides = {}) {
  return {
    nodeUuid: PROBE.nodeUuid,
    sensorId: PROBE.sensorId,
    temperature: 4.25,
    humidity: null,
    co2: null,
    nodeSeq: 1,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function statementsOf(sql) {
  return sql.split('\n');
}

describe('buildReplaceReadingsSql', () => {
  it('replaces the readings in one transaction', () => {
    const statements = statementsOf(
      buildReplaceReadingsSql([{ probe: PROBE, rows: [readingRow()] }]),
    );
    assert.equal(statements[0], 'begin;');
    assert.equal(statements.at(-1), 'commit;');
  });

  it('deletes only the seeded rows of that probe', () => {
    const deletion = statementsOf(
      buildReplaceReadingsSql([{ probe: PROBE, rows: [] }]),
    ).find((statement) => statement.startsWith('delete'));
    assert.equal(
      deletion,
      `delete from sensor_readings where boot_id = '${SEEDED_BOOT_ID}'` +
        " and node_id = '00000000-0000-0000-0000-0000000000aa' and sensor_id = 'scd4x-0';",
    );
  });

  it('marks every row seeded and stamps node_ts with created_at', () => {
    const sql = buildReplaceReadingsSql([
      { probe: PROBE, rows: [readingRow({ humidity: 61.5, co2: 640 })] },
    ]);
    assert.match(
      sql,
      new RegExp(
        "\\('00000000-0000-0000-0000-0000000000aa', 'scd4x-0', 4.25, 61.5, 640, 1, " +
          `'${SEEDED_BOOT_ID}', '2026-10-24T07:00:00.000Z'::timestamptz, '2026-10-24T07:00:00.000Z'::timestamptz\\)`,
      ),
    );
  });

  it('writes a missing humidity and CO2 as null', () => {
    const sql = buildReplaceReadingsSql([
      { probe: PROBE, rows: [readingRow()] },
    ]);
    assert.match(sql, /'scd4x-0', 4.25, null, null, 1,/);
  });

  it('splits many readings into inserts of at most 1000 rows', () => {
    const rows = Array.from({ length: 2001 }, () => readingRow());
    const inserts = statementsOf(
      buildReplaceReadingsSql([{ probe: PROBE, rows }]),
    ).filter((statement) => statement.startsWith('insert'));
    assert.equal(inserts.length, 3);
  });
});

describe('buildFindProbesSql', () => {
  it('ignores seeded rows when listing probes', () => {
    assert.match(
      buildFindProbesSql('America/Vancouver'),
      new RegExp(`boot_id is distinct from '${SEEDED_BOOT_ID}'`),
    );
  });
});

describe('buildFindFirstRealReadingsSql', () => {
  it('looks for real readings from each probe history start on', () => {
    const sql = buildFindFirstRealReadingsSql([
      { probe: PROBE, historyStart: CREATED_AT },
    ]);
    assert.match(
      sql,
      /\('00000000-0000-0000-0000-0000000000aa'::uuid, 'scd4x-0', '2026-10-24T07:00:00.000Z'::timestamptz\)/,
    );
    assert.match(
      sql,
      new RegExp(`boot_id is distinct from '${SEEDED_BOOT_ID}'`),
    );
  });

  it('quotes a sensor id that tries to inject a statement as plain text', () => {
    const sql = buildFindFirstRealReadingsSql([
      {
        probe: { ...PROBE, sensorId: "x'); drop table nodes; --" },
        historyStart: CREATED_AT,
      },
    ]);
    assert.match(sql, /'x''\); drop table nodes; --'/);
  });
});
