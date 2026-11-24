import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplaceHistorySql, quote } from './runtime-history-sql.mjs';

const NOW = new Date('2026-11-23T20:30:00Z');
const HISTORY_START = new Date('2026-10-24T07:00:00Z');

function historyOf(overrides = {}) {
  const line = {
    deviceId: '00000000-0000-0000-0000-000000000001',
    nodeId: 'sim-pi',
    pin: 17,
    ...overrides,
  };
  return {
    line,
    historyStart: HISTORY_START,
    rows: [
      {
        nodeId: line.nodeId,
        pin: line.pin,
        level: 0,
        known: true,
        energised: false,
        deviceId: line.deviceId,
        role: 'heater',
        reason: 'simulated',
        observedAt: HISTORY_START,
      },
    ],
  };
}

function statementsOf(sql) {
  return sql.split('\n');
}

describe('buildReplaceHistorySql', () => {
  it('replaces the history in one transaction', () => {
    const statements = statementsOf(
      buildReplaceHistorySql({ histories: [historyOf()], now: NOW }),
    );
    assert.equal(statements[0], 'begin;');
    assert.equal(statements.at(-1), 'commit;');
  });

  it('deletes only that pin, from the history start up to the instant taken before reading', () => {
    const deletion = statementsOf(
      buildReplaceHistorySql({ histories: [historyOf()], now: NOW }),
    ).find((statement) => statement.startsWith('delete'));
    assert.equal(
      deletion,
      "delete from pin_transitions where node_id = 'sim-pi' and pin = 17" +
        " and observed_at between '2026-10-24T07:00:00.000Z'::timestamptz" +
        " and '2026-11-23T20:30:00.000Z'::timestamptz;",
    );
  });

  it('only ever moves created_at earlier', () => {
    const update = statementsOf(
      buildReplaceHistorySql({ histories: [historyOf()], now: NOW }),
    ).find((statement) => statement.startsWith('update'));
    assert.match(
      update,
      /set created_at = least\(created_at, '2026-10-24T07:00:00.000Z'::timestamptz\)/,
    );
  });

  it('writes a null role as null, not as text', () => {
    const history = historyOf();
    history.rows[0].role = null;
    const sql = buildReplaceHistorySql({ histories: [history], now: NOW });
    assert.match(
      sql,
      /'00000000-0000-0000-0000-000000000001', null, 'simulated'/,
    );
  });

  it('splits a long history into inserts of at most 500 rows', () => {
    const history = historyOf();
    history.rows = Array.from({ length: 1001 }, () => history.rows[0]);
    const inserts = statementsOf(
      buildReplaceHistorySql({ histories: [history], now: NOW }),
    ).filter((statement) => statement.startsWith('insert'));
    assert.equal(inserts.length, 3);
  });
});

describe('quote', () => {
  it('doubles a single quote so a slug cannot end the string', () => {
    assert.equal(quote("o'brien"), "'o''brien'");
  });

  it('quotes a slug that tries to inject a statement as plain text', () => {
    const history = historyOf({ nodeId: "x'; drop table devices; --" });
    const deletion = statementsOf(
      buildReplaceHistorySql({ histories: [history], now: NOW }),
    ).find((statement) => statement.startsWith('delete'));
    assert.match(deletion, /node_id = 'x''; drop table devices; --'/);
  });
});
