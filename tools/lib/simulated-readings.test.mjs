import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { findHistoryStart } from './history-window.mjs';
import { buildClimate, buildSimulatedReadings } from './simulated-readings.mjs';
import { FREEZING_NIGHTS_DAYS_AGO } from './simulated-weather.mjs';

const TIMEZONE = 'America/Vancouver';
const NOW = new Date('2026-11-23T20:30:00Z');
const FIRST_REAL_READING_AT = new Date('2026-11-23T20:00:00Z');
const MINUTES_PER_DAY = 24 * 60;
const SEED_SCRIPT = fileURLToPath(
  new URL('../seed-reading-history.mjs', import.meta.url),
);

function probe(overrides = {}) {
  return {
    nodeUuid: '00000000-0000-0000-0000-0000000000aa',
    nodeId: 'sim-pi',
    sensorId: 'scd4x-0',
    timezone: TIMEZONE,
    reportsHumidity: true,
    reportsCo2: true,
    firstRealReading: { at: FIRST_REAL_READING_AT, temperature: 18 },
    ...overrides,
  };
}

function readingsFor(overrides = {}) {
  const [readings] = buildSimulatedReadings({
    probes: [probe(overrides)],
    now: NOW,
  });
  return readings;
}

const MILLISECONDS_PER_HOUR = 3_600_000;
const localHourByUtcHour = new Map();

// The zone's offsets are whole hours, so one lookup per hour keeps 44,000 rows quick.
function localHourOf(row) {
  const utcHour = Math.floor(row.createdAt.getTime() / MILLISECONDS_PER_HOUR);
  if (!localHourByUtcHour.has(utcHour)) {
    const local = DateTime.fromJSDate(row.createdAt, { zone: TIMEZONE });
    const today = DateTime.fromJSDate(NOW, { zone: TIMEZONE }).startOf('day');
    localHourByUtcHour.set(utcHour, {
      hour: local.hour,
      daysAgo: Math.round(today.diff(local.startOf('day'), 'days').days),
    });
  }
  return localHourByUtcHour.get(utcHour);
}

function coldestBeforeDawn(rows, daysAgo) {
  return Math.min(
    ...rows
      .filter(
        (row) =>
          localHourOf(row).daysAgo === daysAgo && localHourOf(row).hour < 9,
      )
      .map((row) => row.temperature),
  );
}

function averageAtHour(rows, hour) {
  const atHour = rows.filter((row) => localHourOf(row).hour === hour);
  return (
    atHour.reduce((total, row) => total + row.temperature, 0) / atHour.length
  );
}

describe('buildSimulatedReadings', () => {
  it('writes one reading a minute from local midnight thirty days back to the first real reading', () => {
    const { historyStart, rows } = readingsFor();
    assert.equal(
      historyStart.getTime(),
      findHistoryStart(NOW, TIMEZONE).getTime(),
    );
    assert.equal(rows[0].createdAt.getTime(), historyStart.getTime());
    assert.equal(rows.length, (FIRST_REAL_READING_AT - historyStart) / 60_000);
    assert.ok(rows.at(-1).createdAt < FIRST_REAL_READING_AT);
  });

  it('numbers the readings in order, on the probe they belong to', () => {
    const { rows } = readingsFor();
    rows.forEach((row, index) => {
      assert.equal(row.nodeSeq, index + 1);
      assert.equal(row.nodeUuid, '00000000-0000-0000-0000-0000000000aa');
      assert.equal(row.sensorId, 'scd4x-0');
    });
  });

  it('writes nothing when the probe already has a real reading at the window start', () => {
    const historyStart = findHistoryStart(NOW, TIMEZONE);
    const { rows } = readingsFor({
      firstRealReading: { at: historyStart, temperature: 18 },
    });
    assert.equal(rows.length, 0);
  });

  it('is the same on every run', () => {
    assert.deepEqual(readingsFor(), readingsFor());
  });

  it('is coldest before dawn and warmest mid-afternoon', () => {
    const { rows } = readingsFor();
    const beforeDawn = averageAtHour(rows, 6);
    const afternoon = averageAtHour(rows, 15);
    const evening = averageAtHour(rows, 21);
    assert.ok(
      afternoon > evening && evening > beforeDawn,
      `06:00 ${beforeDawn}, 15:00 ${afternoon}, 21:00 ${evening}`,
    );
  });

  it('comes near freezing on the freezing nights, and stays above it elsewhere', () => {
    const { rows } = readingsFor();
    for (const nightDaysAgo of FREEZING_NIGHTS_DAYS_AGO) {
      const coldest = coldestBeforeDawn(rows, nightDaysAgo - 1);
      assert.ok(
        coldest > -0.5 && coldest < 1.5,
        `night ${nightDaysAgo}: ${coldest}`,
      );
    }
    const ordinaryNightLows = Array.from(
      { length: 28 },
      (_, index) => index + 1,
    )
      .filter((daysAgo) => !FREEZING_NIGHTS_DAYS_AGO.includes(daysAgo + 1))
      .map((daysAgo) => coldestBeforeDawn(rows, daysAgo));
    assert.ok(Math.min(...ordinaryNightLows) > 1.5);
  });

  it('meets the first real reading where the seed ends', () => {
    const { rows } = readingsFor();
    assert.ok(Math.abs(rows.at(-1).temperature - 18) < 0.2);
  });

  it('leaves humidity and CO2 null when the probe never reported them', () => {
    const { rows } = readingsFor({ reportsHumidity: false, reportsCo2: false });
    assert.equal(
      rows.some((row) => row.humidity !== null || row.co2 !== null),
      false,
    );
  });

  it('keeps humidity a percentage and CO2 a whole ppm', () => {
    const { rows } = readingsFor();
    for (const row of rows) {
      assert.ok(row.humidity >= 20 && row.humidity <= 99);
      assert.ok(Number.isInteger(row.co2));
    }
  });

  it('gives two probes in one zone slightly different lines', () => {
    const [first, second] = buildSimulatedReadings({
      probes: [probe(), probe({ sensorId: 'ds18b20-1' })],
      now: NOW,
    });
    assert.notEqual(
      first.rows[MINUTES_PER_DAY].temperature,
      second.rows[MINUTES_PER_DAY].temperature,
    );
  });
});

describe('buildClimate', () => {
  it('follows the zone timezone, not the server one', () => {
    const vancouverDawn = DateTime.fromObject(
      { year: 2026, month: 11, day: 20, hour: 6 },
      { zone: TIMEZONE },
    ).toJSDate();
    const vancouverAfternoon = DateTime.fromObject(
      { year: 2026, month: 11, day: 20, hour: 15 },
      { zone: TIMEZONE },
    ).toJSDate();
    const climateAt = buildClimate({
      timezone: TIMEZONE,
      from: findHistoryStart(NOW, TIMEZONE),
      until: NOW,
      now: NOW,
    });
    assert.ok(
      climateAt(vancouverDawn).temperature <
        climateAt(vancouverAfternoon).temperature,
    );
    assert.equal(climateAt(vancouverDawn).nightness, 1);
    assert.equal(climateAt(vancouverAfternoon).nightness, 0);
  });
});

describe('seed-reading-history.mjs', () => {
  function runSeedScript(databaseName) {
    return spawnSync('node', [SEED_SCRIPT, databaseName], { encoding: 'utf8' });
  }

  for (const refused of ['postgres', 'tempestas_prod', 'tempestas_pr_12']) {
    it(`refuses ${refused} before touching any database`, () => {
      const result = runSeedScript(refused);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`refusing ${refused}`));
    });
  }

  it('prints its usage for a flag instead of a database', () => {
    const result = runSeedScript('--help');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: tools\/seed-reading-history\.mjs/);
  });
});
