// Pure: builds pin_transitions rows for devices, from their wiring and a `now`. No database here.
import { DateTime } from 'luxon';
import {
  findHistoryStart,
  HISTORY_DAYS,
  startOfLocalDay,
} from './history-window.mjs';
import { seededRandom } from './seeded-random.mjs';
import { simulateProbeClimate } from './simulated-readings.mjs';
import {
  buildSourceTemperature,
  chooseFailingRole,
  findFaultNight,
  findHeatThermostat,
  simulateThermostatRuns,
} from './simulated-thermostat.mjs';
import { findNightColdness } from './simulated-weather.mjs';

const MILLISECONDS_PER_MINUTE = 60_000;
const DAY_STARTS_AT = { hour: 7, minute: 0 };
const NIGHT_STARTS_AT = { hour: 20, minute: 0 };
const SHORT_CYCLING_DAYS_AGO = 6;
const SHORT_CYCLING_FROM = { hour: 10, minute: 0 };
const SHORT_CYCLING_UNTIL = { hour: 14, minute: 0 };
const OUTAGE_DAYS_AGO = 12;
const OUTAGE_FROM = { hour: 1, minute: 30 };
const OUTAGE_UNTIL = { hour: 5, minute: 0 };
const JITTER_FRACTION = 0.3;
const COLDEST_NIGHT_FACTOR = 1.4;
const MILDEST_NIGHT_FACTOR = 0.7;

const STAYS_OFF = { runMinutes: 0, gapMinutes: 0 };
const ON_ALL_PERIOD = { runMinutes: Infinity, gapMinutes: 0 };
const SHORT_CYCLING = { runMinutes: 3, gapMinutes: 4 };
const HEATING = {
  night: { runMinutes: 30, gapMinutes: 20 },
  day: { runMinutes: 10, gapMinutes: 80 },
};
const DUTY_BY_ROLE = {
  heater: HEATING,
  heat_tape: HEATING,
  co2_generator: HEATING,
  exhaust_fan: { night: STAYS_OFF, day: { runMinutes: 20, gapMinutes: 40 } },
  lights: { night: STAYS_OFF, day: ON_ALL_PERIOD },
};
const DEFAULT_DUTY = {
  night: { runMinutes: 5, gapMinutes: 120 },
  day: { runMinutes: 15, gapMinutes: 60 },
};

/**
 * @typedef {{ level: 0 | 1 | null, known: boolean }} PinState
 * @typedef {{ deviceId: string, nodeId: string, pin: number, onLevel: 0 | 1,
 *   role: string | null, timezone: string, currentState: PinState | null, zoneId: string | null,
 *   rulesConfig: object | null, onDelaySeconds: number, isUnderRules: boolean }} DeviceLine
 * @typedef {{ nodeId: string, pin: number, level: 0 | 1 | null, known: boolean,
 *   energised: boolean | null, deviceId: string, role: string | null, reason: string,
 *   observedAt: Date }} TransitionRow
 * @typedef {{ line: DeviceLine, historyStart: Date, rows: TransitionRow[],
 *   isFollowingThermostat: boolean }} LineHistory
 */

/**
 * A heating line under its zone's rules, with a heat thermostat for its role and a probe its rule
 * reads, follows those probes' seeded temperatures; every other line follows its role's duty pattern.
 * @param {{ lines: DeviceLine[], probes?: import('./simulated-readings.mjs').Probe[], now: Date }} seed
 * @returns {LineHistory[]}
 */
export function buildSimulatedHistory({ lines, probes = [], now }) {
  const outageNodeId = chooseOutageNode(lines);
  const probeClimates = probes.map((probe) => ({
    probe,
    ...simulateProbeClimate(probe, now),
  }));
  const followers = lines.map((line) => ({
    line,
    zoneThermostat: findZoneThermostat(line, probeClimates, now),
  }));
  const failingLines = findFailingLines(followers);
  return followers.map(({ line, zoneThermostat }) =>
    buildLineHistory(line, now, {
      hasOutage: line.nodeId === outageNodeId,
      zoneThermostat,
      isFailing: failingLines.has(line),
    }),
  );
}

function findZoneThermostat(line, probeClimates, now) {
  if (!line.isUnderRules) return null;
  const thermostat = findHeatThermostat(line.rulesConfig, line.role);
  if (!thermostat) return null;
  const zoneProbeClimates = probeClimates.filter(
    (probeClimate) => probeClimate.probe.zoneId === line.zoneId,
  );
  const temperatureAt = buildSourceTemperature(
    zoneProbeClimates,
    thermostat.source,
  );
  const hasSourceProbe = temperatureAt(now.getTime()) !== null;
  if (!hasSourceProbe) return null;
  return { thermostat, temperatureAt };
}

// Chosen from the lines that follow a thermostat, so a rule with no device behind it can't hide the fault.
function findFailingLines(followers) {
  const followingLines = followers
    .filter((follower) => follower.zoneThermostat !== null)
    .map((follower) => follower.line);
  const zoneIds = new Set(followingLines.map((line) => line.zoneId));
  return new Set(
    [...zoneIds].flatMap((zoneId) => {
      const zoneLines = followingLines.filter((line) => line.zoneId === zoneId);
      const failingRole = chooseFailingRole(zoneLines.map((line) => line.role));
      return zoneLines.filter((line) => line.role === failingRole);
    }),
  );
}

// The first node by slug, so the outage lands on the same node every run.
function chooseOutageNode(lines) {
  return lines.map((line) => line.nodeId).sort()[0];
}

function buildLineHistory(line, now, { hasOutage, zoneThermostat, isFailing }) {
  const historyStart = findHistoryStart(now, line.timezone);
  const runs = zoneThermostat
    ? simulateHeatingRuns(line, zoneThermostat, isFailing, historyStart, now)
    : simulateRuns(line, historyStart, now);
  let rows = toTransitionRows(line, runs, historyStart, now);
  if (hasOutage) {
    rows = cutOutOutage(line, rows, findOutage(now, line.timezone));
  }
  rows = appendCurrentState(line, rows, now);
  return {
    line,
    historyStart,
    rows: dropRepeatedStates(rows),
    isFollowingThermostat: zoneThermostat !== null,
  };
}

// The short-cycling morning overrides the thermostat, as a chattering relay would.
function simulateHeatingRuns(
  line,
  zoneThermostat,
  isFailing,
  historyStart,
  now,
) {
  const thermostatRuns = simulateThermostatRuns({
    ...zoneThermostat,
    onDelaySeconds: line.onDelaySeconds,
    fromMs: historyStart.getTime(),
    untilMs: now.getTime(),
    isFailing: isFailing ? buildFaultCheck(line, now) : () => false,
  });
  const shortCyclingPeriods = listPeriods(
    line.timezone,
    historyStart,
    now,
  ).filter((period) => period.kind === 'short-cycling');
  const shortCyclingRuns = shortCyclingPeriods.flatMap((period) =>
    simulatePeriod(period, SHORT_CYCLING, seedRandomFor(line, period)),
  );
  const runsAroundShortCycling = shortCyclingPeriods.reduce(
    cutOutPeriod,
    thermostatRuns,
  );
  return mergeTouchingRuns(
    [...runsAroundShortCycling, ...shortCyclingRuns].sort(
      (first, second) => first.fromMs - second.fromMs,
    ),
  );
}

function buildFaultCheck(line, now) {
  const faultNight = findFaultNight(now, line.timezone);
  return (atMs) => atMs >= faultNight.fromMs && atMs < faultNight.toMs;
}

function cutOutPeriod(runs, period) {
  return runs.flatMap((run) => {
    if (run.toMs <= period.fromMs || run.fromMs >= period.toMs) return [run];
    const pieces = [];
    if (run.fromMs < period.fromMs) {
      pieces.push({ fromMs: run.fromMs, toMs: period.fromMs });
    }
    if (run.toMs > period.toMs) {
      pieces.push({ fromMs: period.toMs, toMs: run.toMs });
    }
    return pieces;
  });
}

function simulateRuns(line, historyStart, now) {
  const duty = DUTY_BY_ROLE[line.role] ?? DEFAULT_DUTY;
  const runs = listPeriods(line.timezone, historyStart, now).flatMap((period) =>
    simulatePeriod(
      period,
      dutyFor(period.kind, duty),
      seedRandomFor(line, period),
    ),
  );
  return mergeTouchingRuns(runs).filter((run) => run.fromMs < now.getTime());
}

function seedRandomFor(line, period) {
  return seededRandom(`${line.nodeId}:${line.pin}:${period.key}`);
}

function dutyFor(kind, duty) {
  if (kind === 'short-cycling') return SHORT_CYCLING;
  return duty[kind];
}

// Nights run 20:00 to 07:00 local, so a heater's night is one stretch across midnight.
function listPeriods(timezone, historyStart, now) {
  const firstDay = DateTime.fromJSDate(historyStart, { zone: timezone });
  const periods = [
    buildPeriod(
      'night',
      firstDay,
      firstDay.set(DAY_STARTS_AT),
      HISTORY_DAYS + 1,
    ),
  ];
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo--) {
    const day = firstDay.plus({ days: HISTORY_DAYS - daysAgo });
    periods.push(...listDaytimePeriods(day, daysAgo));
    periods.push(
      buildPeriod(
        'night',
        day.set(NIGHT_STARTS_AT),
        day.plus({ days: 1 }).set(DAY_STARTS_AT),
        daysAgo,
      ),
    );
  }
  return periods.filter((candidate) => candidate.fromMs < now.getTime());
}

function listDaytimePeriods(day, daysAgo) {
  const morning = day.set(DAY_STARTS_AT);
  const evening = day.set(NIGHT_STARTS_AT);
  if (daysAgo !== SHORT_CYCLING_DAYS_AGO) {
    return [buildPeriod('day', morning, evening, daysAgo)];
  }
  const shortCyclingFrom = day.set(SHORT_CYCLING_FROM);
  const shortCyclingUntil = day.set(SHORT_CYCLING_UNTIL);
  return [
    buildPeriod('day', morning, shortCyclingFrom, daysAgo),
    buildPeriod('short-cycling', shortCyclingFrom, shortCyclingUntil, daysAgo),
    buildPeriod('day', shortCyclingUntil, evening, daysAgo),
  ];
}

function buildPeriod(kind, from, to, daysAgo) {
  return {
    kind,
    daysAgo,
    fromMs: from.toMillis(),
    toMs: to.toMillis(),
    key: `${daysAgo}:${kind}:${from.toFormat('HH:mm')}`,
  };
}

function simulatePeriod(period, duty, random) {
  if (duty.runMinutes === 0) return [];
  const runMinutes =
    duty.runMinutes *
    (period.kind === 'night' ? nightRunFactor(period.daysAgo) : 1);
  const runs = [];
  let cursorMs = period.fromMs + jitterMinutes(duty.gapMinutes / 2, random);
  while (cursorMs < period.toMs) {
    const runEndMs = findRunEnd(cursorMs, runMinutes, period, random);
    runs.push({ fromMs: cursorMs, toMs: runEndMs });
    cursorMs = runEndMs + jitterMinutes(duty.gapMinutes, random);
  }
  return runs;
}

// A run in progress finishes past the period's end: cutting it there would invent a short run.
function findRunEnd(startMs, runMinutes, period, random) {
  if (!Number.isFinite(runMinutes)) return period.toMs;
  return startMs + jitterMinutes(runMinutes, random);
}

function nightRunFactor(daysAgo) {
  return (
    MILDEST_NIGHT_FACTOR +
    (COLDEST_NIGHT_FACTOR - MILDEST_NIGHT_FACTOR) * findNightColdness(daysAgo)
  );
}

function jitterMinutes(minutes, random) {
  if (!Number.isFinite(minutes)) return minutes;
  const factor = 1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random();
  return Math.round(minutes * factor * MILLISECONDS_PER_MINUTE);
}

// A run that overran its period may reach into the next one; a zero-length off is no transition.
function mergeTouchingRuns(runs) {
  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (previous && run.fromMs <= previous.toMs) {
      previous.toMs = Math.max(previous.toMs, run.toMs);
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function toTransitionRows(line, runs, historyStart, now) {
  const rows = [toRow(line, 'off', 'first-sight', historyStart)];
  for (const run of runs) {
    rows.push(toRow(line, 'on', 'level-changed', new Date(run.fromMs)));
    if (run.toMs < now.getTime()) {
      rows.push(toRow(line, 'off', 'level-changed', new Date(run.toMs)));
    }
  }
  return rows;
}

function dropRepeatedStates(rows) {
  return rows.filter(
    (row, index) => index === 0 || !isSameState(rows[index - 1], row),
  );
}

function findOutage(now, timezone) {
  const day = startOfLocalDay(now, timezone).minus({ days: OUTAGE_DAYS_AGO });
  return {
    from: day.set(OUTAGE_FROM).toJSDate(),
    until: day.set(OUTAGE_UNTIL).toJSDate(),
  };
}

// As the server writes it: unknown when the node drops, then whatever the relay is doing when it returns.
function cutOutOutage(line, rows, outage) {
  const before = rows.filter((row) => row.observedAt < outage.from);
  const after = rows.filter((row) => row.observedAt > outage.until);
  const inForceOnReturn = rows
    .filter((row) => row.observedAt <= outage.until)
    .at(-1);
  return [
    ...before,
    toRow(line, 'unknown', 'node-offline', outage.from),
    toRow(line, stateOf(inForceOnReturn), 'level-changed', outage.until),
    ...after,
  ];
}

// Ends on what the relay is doing now, so the server's next report continues the history.
function appendCurrentState(line, rows, now) {
  if (!line.currentState) return rows;
  const current = toRowFromLevel(line, line.currentState, now);
  if (isSameState(rows.at(-1), current)) return rows;
  return [...rows, current];
}

function toRowFromLevel(line, pinState, at) {
  if (!pinState.known || pinState.level === null) {
    return toRow(line, 'unknown', 'became-unknown', at);
  }
  return toRow(
    line,
    pinState.level === line.onLevel ? 'on' : 'off',
    'level-changed',
    at,
  );
}

function toRow(line, state, reason, observedAt) {
  return {
    nodeId: line.nodeId,
    pin: line.pin,
    level: levelFor(state, line.onLevel),
    known: state !== 'unknown',
    energised: state === 'unknown' ? null : state === 'on',
    deviceId: line.deviceId,
    role: line.role,
    reason,
    observedAt,
  };
}

function levelFor(state, onLevel) {
  if (state === 'unknown') return null;
  return state === 'on' ? onLevel : 1 - onLevel;
}

function stateOf(row) {
  if (!row.known) return 'unknown';
  return row.energised ? 'on' : 'off';
}

function isSameState(first, second) {
  return first.known === second.known && first.level === second.level;
}
