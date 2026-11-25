import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import { HISTORY_DAYS } from './history-window.mjs';
import { buildSimulatedHistory } from './simulated-runtime-history.mjs';
import { buildSimulatedReadings } from './simulated-readings.mjs';
import { FAULT_NIGHT_DAYS_AGO } from './simulated-thermostat.mjs';
import { FREEZING_NIGHTS_DAYS_AGO } from './simulated-weather.mjs';

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

  it('runs a heater longest on the freezing nights', () => {
    const [history] = historyFor([deviceLine()]);
    const minutesByNight = new Map();
    for (const run of listRuns(history.rows)) {
      const started = DateTime.fromJSDate(run.startedAt, { zone: TIMEZONE });
      if (started.hour < 20) continue;
      const night = daysAgoOf({ observedAt: run.startedAt });
      minutesByNight.set(night, (minutesByNight.get(night) ?? 0) + run.minutes);
    }
    const ordinaryMinutes = [...minutesByNight]
      .filter(([night]) => !FREEZING_NIGHTS_DAYS_AGO.includes(night))
      .map(([, minutes]) => minutes)
      .sort((first, second) => first - second);
    const medianOrdinary =
      ordinaryMinutes[Math.floor(ordinaryMinutes.length / 2)];
    for (const night of FREEZING_NIGHTS_DAYS_AGO) {
      assert.ok(
        minutesByNight.get(night) > medianOrdinary,
        `night ${night}: ${minutesByNight.get(night)} min, ordinary median ${medianOrdinary}`,
      );
    }
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

const ZONE_ID = '00000000-0000-0000-0000-00000000000z';
const ON_DELAY_SECONDS = 300;
const HEAT_TAPE = { onAtC: 4, offAtC: 6 };
const HEATER = { onAtC: 2, offAtC: 5 };
const PUMPHOUSE_RULES = {
  enabledRoles: ['heater', 'heat_tape'],
  sensorPolicy: { default: { source: 'min', maxAgeMs: 120000 } },
  rules: {
    heat_tape: {
      kind: 'thermostat',
      mode: 'heat',
      ...HEAT_TAPE,
      onStale: 'on',
    },
    heater: { kind: 'thermostat', mode: 'heat', ...HEATER, onStale: 'on' },
  },
  timezone: TIMEZONE,
};
const PUMPHOUSE_PROBE = {
  nodeUuid: '00000000-0000-0000-0000-0000000000aa',
  nodeId: 'sim-pi',
  zoneId: ZONE_ID,
  sensorId: 'ds18b20-0',
  timezone: TIMEZONE,
  reportsHumidity: false,
  reportsCo2: false,
  firstRealReading: { at: new Date('2026-11-23T20:00:00Z'), temperature: 7 },
};

function pumphouseLine(overrides = {}) {
  return deviceLine({
    zoneId: ZONE_ID,
    rulesConfig: PUMPHOUSE_RULES,
    onDelaySeconds: ON_DELAY_SECONDS,
    ...overrides,
  });
}

function pumphouseHistories() {
  return buildSimulatedHistory({
    lines: [
      pumphouseLine({ nodeId: 'aa-pi', deviceId: 'heater' }),
      pumphouseLine({ deviceId: 'tape', pin: 27, role: 'heat_tape' }),
    ],
    probes: [PUMPHOUSE_PROBE],
    now: NOW,
  });
}

// What the readings seeder writes for the zone's only probe, keyed by minute.
const seededTemperatureByMinute = new Map(
  buildSimulatedReadings({ probes: [PUMPHOUSE_PROBE], now: NOW })[0].rows.map(
    (row) => [row.createdAt.getTime(), row.temperature],
  ),
);

function seededTemperatureAt(instant) {
  return seededTemperatureByMinute.get(instant.getTime());
}

function isSwitchedByThermostat(row) {
  return (
    row.reason === 'level-changed' &&
    daysAgoOf(row) !== 6 &&
    seededTemperatureByMinute.has(row.observedAt.getTime())
  );
}

function isInFaultNight(row) {
  const local = DateTime.fromJSDate(row.observedAt, { zone: TIMEZONE });
  const daysAgo = daysAgoOf(row);
  return (
    (daysAgo === FAULT_NIGHT_DAYS_AGO && local.hour >= 20) ||
    (daysAgo === FAULT_NIGHT_DAYS_AGO - 1 && local.hour < 7)
  );
}

function stateAt(rows, instant) {
  return rows.filter((row) => row.observedAt <= instant).at(-1);
}

function coldestMomentOfNight(nightDaysAgo) {
  const evening = DateTime.fromJSDate(NOW, { zone: TIMEZONE })
    .startOf('day')
    .minus({ days: nightDaysAgo })
    .set({ hour: 20 });
  const morning = evening.plus({ days: 1 }).set({ hour: 7 });
  let coldest = null;
  for (const [atMs, temperature] of seededTemperatureByMinute) {
    if (atMs < evening.toMillis() || atMs >= morning.toMillis()) continue;
    if (!coldest || temperature < coldest.temperature) {
      coldest = { at: new Date(atMs), temperature };
    }
  }
  return coldest;
}

describe('buildSimulatedHistory, for a heating role with a thermostat', () => {
  const [heaterHistory, heatTapeHistory] = pumphouseHistories();

  for (const [name, history, setpoints] of [
    ['heater', heaterHistory, HEATER],
    ['heat tape', heatTapeHistory, HEAT_TAPE],
  ]) {
    it(`switches the ${name} on only below its on-setpoint`, () => {
      const switchedOn = history.rows.filter(
        (row) => row.energised && isSwitchedByThermostat(row),
      );
      assert.ok(switchedOn.length > 0);
      for (const row of switchedOn) {
        const temperature = seededTemperatureAt(row.observedAt);
        assert.ok(
          temperature < setpoints.onAtC,
          `${row.observedAt.toISOString()}: on at ${temperature}`,
        );
      }
    });

    it(`switches the ${name} off only above its off point, outside the fault night`, () => {
      const switchedOff = history.rows.filter(
        (row) =>
          row.energised === false &&
          isSwitchedByThermostat(row) &&
          !isInFaultNight(row),
      );
      assert.ok(switchedOff.length > 0);
      for (const row of switchedOff) {
        const temperature = seededTemperatureAt(row.observedAt);
        assert.ok(
          temperature > setpoints.offAtC,
          `${row.observedAt.toISOString()}: off at ${temperature}`,
        );
      }
    });

    it(`waits out the ${name}'s on delay after every thermostat off`, () => {
      history.rows.forEach((row, index) => {
        const next = history.rows[index + 1];
        if (row.energised !== false || !next?.energised) return;
        if (!isSwitchedByThermostat(next) || isInFaultNight(row)) return;
        assert.ok(
          next.observedAt - row.observedAt >= ON_DELAY_SECONDS * 1000,
          `${row.observedAt.toISOString()} to ${next.observedAt.toISOString()}`,
        );
      });
    });
  }

  it('has the heat on at the coldest moment of an ordinary freezing night', () => {
    const coldest = coldestMomentOfNight(4);
    assert.ok(coldest.temperature < HEATER.onAtC);
    assert.equal(stateAt(heaterHistory.rows, coldest.at).energised, true);
    assert.equal(stateAt(heatTapeHistory.rows, coldest.at).energised, true);
  });

  it(`fails the heat tape, not the heater, through the night ${FAULT_NIGHT_DAYS_AGO} days ago`, () => {
    const coldest = coldestMomentOfNight(FAULT_NIGHT_DAYS_AGO);
    assert.ok(coldest.temperature < HEAT_TAPE.onAtC);
    assert.equal(stateAt(heatTapeHistory.rows, coldest.at).energised, false);
    assert.equal(stateAt(heaterHistory.rows, coldest.at).energised, true);
  });

  it('still short-cycles on day 6 only, and still drops the first node offline', () => {
    const shortRunDays = new Set(
      listRuns(heaterHistory.rows)
        .filter((run) => run.minutes < 5)
        .map((run) => daysAgoOf({ observedAt: run.startedAt })),
    );
    assert.deepEqual([...shortRunDays], [6]);
    const offline = heaterHistory.rows.find(
      (row) => row.reason === 'node-offline',
    );
    assert.equal(daysAgoOf(offline), 12);
  });

  it('is the same history on every run', () => {
    assert.deepEqual(pumphouseHistories(), pumphouseHistories());
  });

  it('says which lines follow the thermostat', () => {
    assert.deepEqual(
      [
        heaterHistory.isFollowingThermostat,
        heatTapeHistory.isFollowingThermostat,
      ],
      [true, true],
    );
  });

  it('falls back to the night pattern when no probe in the zone has reported', () => {
    const [history] = buildSimulatedHistory({
      lines: [pumphouseLine()],
      probes: [{ ...PUMPHOUSE_PROBE, zoneId: 'another-zone' }],
      now: NOW,
    });
    assert.equal(history.isFollowingThermostat, false);
    assert.deepEqual(history.rows, historyFor([deviceLine()])[0].rows);
  });

  it('leaves fans and lights to their daily pattern', () => {
    for (const role of ['exhaust_fan', 'lights']) {
      const [withProbes] = buildSimulatedHistory({
        lines: [pumphouseLine({ role })],
        probes: [PUMPHOUSE_PROBE],
        now: NOW,
      });
      const [withoutProbes] = historyFor([deviceLine({ role })]);
      assert.equal(withProbes.isFollowingThermostat, false);
      assert.deepEqual(withProbes.rows, withoutProbes.rows);
    }
  });
});

describe('seed-runtime-history.mjs', () => {
  function runSeedScript(databaseName) {
    return spawnSync('node', [SEED_SCRIPT, databaseName], { encoding: 'utf8' });
  }

  for (const refused of [
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
