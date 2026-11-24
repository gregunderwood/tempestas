import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import {
  buildSimulatedHistory,
  HISTORY_DAYS,
} from './simulated-runtime-history.mjs';

const TIMEZONE = 'America/Vancouver';
const NOW = new Date('2026-11-23T20:30:00Z');
const SEED_SCRIPT = fileURLToPath(
  new URL('../seed-runtime-history.mjs', import.meta.url),
);

function deviceLine(overrides = {}) {
  return {
    deviceId: '00000000-0000-0000-0000-000000000001',
    nodeId: 'sim-pi',
    pin: 17,
    onLevel: 1,
    role: 'heater',
    timezone: TIMEZONE,
    currentState: null,
    ...overrides,
  };
}

function historyFor(lines) {
  return buildSimulatedHistory({ lines, now: NOW });
}

function localHourOf(row) {
  return DateTime.fromJSDate(row.observedAt, { zone: TIMEZONE }).hour;
}

function daysAgoOf(row) {
  const today = DateTime.fromJSDate(NOW, { zone: TIMEZONE }).startOf('day');
  const day = DateTime.fromJSDate(row.observedAt, { zone: TIMEZONE }).startOf(
    'day',
  );
  return Math.round(today.diff(day, 'days').days);
}

function listRuns(rows) {
  return rows.flatMap((row, index) => {
    const next = rows[index + 1];
    if (!row.energised || !next) return [];
    return [
      {
        startedAt: row.observedAt,
        minutes: (next.observedAt - row.observedAt) / 60_000,
      },
    ];
  });
}

function isNightHour(hour) {
  return hour < 7 || hour >= 20;
}

describe('buildSimulatedHistory', () => {
  it('starts every line off at local midnight thirty days back', () => {
    const [history] = historyFor([deviceLine()]);
    const expectedStart = DateTime.fromJSDate(NOW, { zone: TIMEZONE })
      .startOf('day')
      .minus({ days: HISTORY_DAYS });
    assert.equal(history.historyStart.getTime(), expectedStart.toMillis());
    assert.deepEqual(
      {
        observedAt: history.rows[0].observedAt,
        energised: history.rows[0].energised,
        reason: history.rows[0].reason,
      },
      {
        observedAt: history.historyStart,
        energised: false,
        reason: 'first-sight',
      },
    );
  });

  it('is the same history on every run', () => {
    assert.deepEqual(historyFor([deviceLine()]), historyFor([deviceLine()]));
  });

  it('writes rows oldest first, all before now, and never the same state twice in a row', () => {
    const [history] = historyFor([deviceLine()]);
    history.rows.forEach((row, index) => {
      assert.ok(row.observedAt <= NOW);
      if (index === 0) return;
      const previous = history.rows[index - 1];
      assert.ok(previous.observedAt < row.observedAt);
      assert.ok(previous.level !== row.level || previous.known !== row.known);
    });
  });

  it('runs a heater more at night than by day', () => {
    const [history] = historyFor([deviceLine()]);
    const runs = listRuns(history.rows);
    const nightMinutes = runs
      .filter((run) =>
        isNightHour(
          DateTime.fromJSDate(run.startedAt, { zone: TIMEZONE }).hour,
        ),
      )
      .reduce((total, run) => total + run.minutes, 0);
    const dayMinutes = runs
      .filter(
        (run) =>
          !isNightHour(
            DateTime.fromJSDate(run.startedAt, { zone: TIMEZONE }).hour,
          ),
      )
      .reduce((total, run) => total + run.minutes, 0);
    assert.ok(
      nightMinutes > 2 * dayMinutes,
      `night ${nightMinutes} min, day ${dayMinutes} min`,
    );
  });

  it('short-cycles on one day only', () => {
    const [history] = historyFor([deviceLine()]);
    const shortRunDays = new Set(
      listRuns(history.rows)
        .filter((run) => run.minutes < 5)
        .map((run) => daysAgoOf({ observedAt: run.startedAt })),
    );
    assert.deepEqual([...shortRunDays], [6]);
  });

  it('drops the first node offline for a few hours and brings it back known', () => {
    const histories = historyFor([
      deviceLine(),
      deviceLine({ nodeId: 'zz-pi', deviceId: 'other' }),
    ]);
    const [outageLine, steadyLine] = histories;
    const offlineIndex = outageLine.rows.findIndex(
      (row) => row.reason === 'node-offline',
    );
    const offline = outageLine.rows[offlineIndex];
    const returned = outageLine.rows[offlineIndex + 1];
    assert.deepEqual(
      {
        level: offline.level,
        known: offline.known,
        energised: offline.energised,
      },
      { level: null, known: false, energised: null },
    );
    assert.equal(returned.known, true);
    assert.equal((returned.observedAt - offline.observedAt) / 3_600_000, 3.5);
    assert.equal(daysAgoOf(offline), 12);
    assert.equal(
      steadyLine.rows.some((row) => !row.known),
      false,
    );
  });

  it('writes the device on level for an active-low relay', () => {
    const [history] = historyFor([deviceLine({ onLevel: 0 })]);
    const firstRun = history.rows.find((row) => row.energised);
    assert.equal(firstRun.level, 0);
    assert.equal(history.rows[0].level, 1);
  });

  it('keeps every row on the device, its node slug, pin and role', () => {
    const [history] = historyFor([deviceLine()]);
    const identities = new Set(
      history.rows.map(
        (row) => `${row.deviceId} ${row.nodeId} ${row.pin} ${row.role}`,
      ),
    );
    assert.deepEqual(
      [...identities],
      ['00000000-0000-0000-0000-000000000001 sim-pi 17 heater'],
    );
  });

  it('ends on the state the pin is in now, so the server carries on from it', () => {
    const [history] = historyFor([
      deviceLine({ currentState: { level: null, known: false } }),
    ]);
    const last = history.rows.at(-1);
    assert.deepEqual(
      { observedAt: last.observedAt, known: last.known, reason: last.reason },
      { observedAt: NOW, known: false, reason: 'became-unknown' },
    );
  });

  it('adds no row when the pin is already in the state the history ends on', () => {
    const [withoutCurrent] = historyFor([deviceLine()]);
    const lastRow = withoutCurrent.rows.at(-1);
    const [withCurrent] = historyFor([
      deviceLine({
        currentState: { level: lastRow.level, known: lastRow.known },
      }),
    ]);
    assert.equal(withCurrent.rows.length, withoutCurrent.rows.length);
  });

  it('keeps lights on through the day and off at night', () => {
    const [history] = historyFor([deviceLine({ role: 'lights' })]);
    const steadyDays = history.rows.filter(
      (row) => daysAgoOf(row) === 2 && row.known,
    );
    assert.deepEqual(
      steadyDays.map((row) => [localHourOf(row), row.energised]),
      [
        [7, true],
        [20, false],
      ],
    );
  });
});

describe('seed-runtime-history.mjs', () => {
  function runSeedScript(databaseName) {
    return spawnSync('node', [SEED_SCRIPT, databaseName], { encoding: 'utf8' });
  }

  for (const refused of [
    'tempestas',
    'postgres',
    'tempestas_prod',
    'tempestas_pr_12',
    'tempestas_dev;drop',
  ]) {
    it(`refuses ${refused} before touching any database`, () => {
      const result = runSeedScript(refused);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(`refusing ${refused.replace(/[;]/g, '.')}`),
      );
    });
  }
});
