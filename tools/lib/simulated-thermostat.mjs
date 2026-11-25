// Pure: when a heating relay runs, switched by its zone's seeded temperatures as the server's rules would.
import { startOfLocalDay } from './history-window.mjs';
import { READING_INTERVAL_MINUTES } from './simulated-readings.mjs';

export const FAULT_NIGHT_DAYS_AGO = 17;

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_SECOND = 1_000;
const STEP_MS = READING_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE;
const FAULT_NIGHT_FROM = { hour: 20, minute: 0 };
const FAULT_NIGHT_UNTIL = { hour: 7, minute: 0 };
const DEFAULT_SENSOR_SOURCE = 'mean';
const NODE_SOURCE_PREFIX = 'node:';
const SENSOR_SOURCE_PREFIX = 'sensor:';
// The heat tape first: when a zone has both, it is the one that fails, and the heater still comes on.
export const THERMOSTAT_ROLES = ['heat_tape', 'heater'];

/**
 * @typedef {{ onAtC: number, offAtC: number, source: string }} HeatThermostat
 * @typedef {{ probe: import('./simulated-readings.mjs').Probe, historyStart: Date,
 *   minutes: import('./simulated-readings.mjs').ProbeMinute[] }} ProbeClimate
 * @typedef {{ fromMs: number, toMs: number }} Run
 */

/** The role's heat thermostat in the zone's rules, or null when it has none to follow. */
export function findHeatThermostat(rulesConfig, role) {
  if (!THERMOSTAT_ROLES.includes(role)) return null;
  const rule = rulesConfig?.rules?.[role];
  if (!isHeatThermostat(rule)) return null;
  return {
    onAtC: rule.onAtC,
    offAtC: rule.offAtC,
    source:
      rule.sensor?.source ??
      rulesConfig.sensorPolicy?.default?.source ??
      DEFAULT_SENSOR_SOURCE,
  };
}

function isHeatThermostat(rule) {
  return (
    rule?.kind === 'thermostat' &&
    rule.mode === 'heat' &&
    Number.isFinite(rule.onAtC) &&
    Number.isFinite(rule.offAtC)
  );
}

// One role per zone fails on the fault night, so the freeze-margin report has a night to flag.
export function chooseFailingRole(rulesConfig) {
  return (
    THERMOSTAT_ROLES.find(
      (role) => findHeatThermostat(rulesConfig, role) !== null,
    ) ?? null
  );
}

export function findFaultNight(now, timezone) {
  const evening = startOfLocalDay(now, timezone).minus({
    days: FAULT_NIGHT_DAYS_AGO,
  });
  return {
    fromMs: evening.set(FAULT_NIGHT_FROM).toMillis(),
    toMs: evening.plus({ days: 1 }).set(FAULT_NIGHT_UNTIL).toMillis(),
  };
}

/**
 * The zone's temperature as the rule's sensor source sees it, rounded as the climate resolver
 * rounds it. After a probe's seed ends it holds that probe's first real reading. Null when the
 * source has no probe at that minute.
 * @param {ProbeClimate[]} probeClimates the zone's own probes
 */
export function buildSourceTemperature(probeClimates, source) {
  const selected = probeClimates.filter((probeClimate) =>
    isInSource(probeClimate.probe, source),
  );
  return (atMs) => {
    const temperatures = selected
      .map((probeClimate) => readTemperatureAt(probeClimate, atMs))
      .filter((temperature) => temperature !== null);
    if (temperatures.length === 0) return null;
    return roundToHundredths(pickBySource(temperatures, source));
  };
}

function isInSource(probe, source) {
  if (source.startsWith(NODE_SOURCE_PREFIX)) {
    return probe.nodeId === source.slice(NODE_SOURCE_PREFIX.length);
  }
  if (source.startsWith(SENSOR_SOURCE_PREFIX)) {
    return (
      `${probe.nodeId}/${probe.sensorId}` ===
      source.slice(SENSOR_SOURCE_PREFIX.length)
    );
  }
  return true;
}

function readTemperatureAt(probeClimate, atMs) {
  const index = Math.floor(
    (atMs - probeClimate.historyStart.getTime()) / STEP_MS,
  );
  if (index < 0) return null;
  if (index >= probeClimate.minutes.length) {
    return probeClimate.probe.firstRealReading.temperature;
  }
  return probeClimate.minutes[index].temperature;
}

function pickBySource(temperatures, source) {
  if (source === 'min') return Math.min(...temperatures);
  if (source === 'max') return Math.max(...temperatures);
  return (
    temperatures.reduce((sum, temperature) => sum + temperature, 0) /
    temperatures.length
  );
}

/**
 * On strictly below `onAtC`, off strictly above `offAtC`, and never back on until `onDelaySeconds`
 * after it went off. While `isFailing`, it cannot come on, and goes off if it was on.
 * @returns {Run[]} a run still going at `untilMs` ends there
 */
export function simulateThermostatRuns({
  thermostat,
  temperatureAt,
  onDelaySeconds,
  fromMs,
  untilMs,
  isFailing = () => false,
}) {
  const runs = [];
  let onSinceMs = null;
  let earliestOnMs = -Infinity;
  for (let atMs = fromMs; atMs < untilMs; atMs += STEP_MS) {
    const temperature = temperatureAt(atMs);
    const isOn = onSinceMs !== null;
    if (!isOn && temperature !== null) {
      const isOwedHeat = temperature < thermostat.onAtC;
      if (isOwedHeat && atMs >= earliestOnMs && !isFailing(atMs)) {
        onSinceMs = atMs;
      }
    } else if (isOn && (isFailing(atMs) || temperature > thermostat.offAtC)) {
      runs.push({ fromMs: onSinceMs, toMs: atMs });
      onSinceMs = null;
      earliestOnMs = atMs + onDelaySeconds * MILLISECONDS_PER_SECOND;
    }
  }
  if (onSinceMs !== null) runs.push({ fromMs: onSinceMs, toMs: untilMs });
  return runs;
}

function roundToHundredths(value) {
  return Math.round(value * 100) / 100;
}
