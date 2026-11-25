// Pure: builds sensor_readings rows for probes, from their zone's timezone and a `now`. No database here.
import {
  countDaysAgo,
  findHistoryStart,
  startOfLocalDay,
} from './history-window.mjs';
import { seededRandom } from './seeded-random.mjs';
import { findNightColdness } from './simulated-weather.mjs';

export const READING_INTERVAL_MINUTES = 1;

const MILLISECONDS_PER_MINUTE = 60_000;
const COLDEST_AT = { hour: 6, minute: 0 };
const WARMEST_AT = { hour: 15, minute: 0 };
const MILDEST_NIGHT_LOW_C = 9;
const FREEZING_NIGHT_LOW_C = 0.6;
const WARMEST_AFTERNOON_C = 17;
const COLDEST_AFTERNOON_C = 8;
const PROBE_OFFSET_RANGE_C = 0.8;
const TEMPERATURE_NOISE_RANGE_C = 0.3;
const MINUTES_TO_MEET_FIRST_REAL_READING = 60;
const HUMIDITY_AT_MILDEST_LOW_PCT = 60;
const HUMIDITY_PCT_PER_DEGREE_COLDER = 2.5;
const HUMIDITY_NOISE_RANGE_PCT = 2;
const LOWEST_HUMIDITY_PCT = 20;
const HIGHEST_HUMIDITY_PCT = 99;
const AFTERNOON_CO2_PPM = 430;
const PRE_DAWN_CO2_RISE_PPM = 250;
const CO2_NOISE_RANGE_PPM = 20;

/**
 * @typedef {{ at: Date, temperature: number }} RealReading
 * @typedef {{ nodeUuid: string, nodeId: string, zoneId: string | null, sensorId: string, timezone: string,
 *   reportsHumidity: boolean, reportsCo2: boolean, firstRealReading: RealReading }} Probe
 * @typedef {{ nodeUuid: string, sensorId: string, temperature: number, humidity: number | null,
 *   co2: number | null, nodeSeq: number, createdAt: Date }} ReadingRow
 * @typedef {{ probe: Probe, historyStart: Date, rows: ReadingRow[] }} ProbeReadings
 * @typedef {{ atMs: number, temperature: number }} Extreme
 * @typedef {{ at: Date, temperature: number, nightness: number }} ProbeMinute
 */

/** @returns {ProbeReadings[]} */
export function buildSimulatedReadings({ probes, now }) {
  return probes.map((probe) => buildProbeReadings(probe, now));
}

function buildProbeReadings(probe, now) {
  const { historyStart, minutes } = simulateProbeClimate(probe, now);
  const random = seededRandom(`${probe.nodeId}:${probe.sensorId}:readings`);
  const rows = minutes.map((minute, index) => ({
    nodeUuid: probe.nodeUuid,
    sensorId: probe.sensorId,
    temperature: minute.temperature,
    humidity: probe.reportsHumidity
      ? simulateHumidity(minute.temperature, random)
      : null,
    co2: probe.reportsCo2 ? simulateCo2(minute.nightness, random) : null,
    nodeSeq: index + 1,
    createdAt: minute.at,
  }));
  return { probe, historyStart, rows };
}

/**
 * What one probe reads each minute, from the window start up to its first real reading, which it
 * is never allowed to shadow. The runtime seeder switches heaters by these same temperatures.
 * @returns {{ historyStart: Date, minutes: ProbeMinute[] }}
 */
export function simulateProbeClimate(probe, now) {
  const historyStart = findHistoryStart(now, probe.timezone);
  const offsetC = findProbeOffset(probe);
  const random = seededRandom(`${probe.nodeId}:${probe.sensorId}:temperature`);
  const climateAt = buildClimate({
    timezone: probe.timezone,
    from: historyStart,
    until: probe.firstRealReading.at,
    now,
  });
  const minutes = [];
  for (
    let atMs = historyStart.getTime();
    atMs < probe.firstRealReading.at.getTime();
    atMs += READING_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE
  ) {
    const at = new Date(atMs);
    const climate = climateAt(at);
    const modelledC =
      climate.temperature + offsetC + spread(TEMPERATURE_NOISE_RANGE_C, random);
    minutes.push({
      at,
      temperature: roundTo(meetFirstRealReading(modelledC, at, probe), 2),
      nightness: climate.nightness,
    });
  }
  return { historyStart, minutes };
}

function findProbeOffset(probe) {
  const random = seededRandom(`${probe.nodeId}:${probe.sensorId}:offset`);
  return (random() - 0.5) * PROBE_OFFSET_RANGE_C;
}

// The last hour leans toward the first real reading, so the chart does not jump where the seed ends.
function meetFirstRealReading(modelledC, createdAt, probe) {
  const minutesLeft =
    (probe.firstRealReading.at.getTime() - createdAt.getTime()) /
    MILLISECONDS_PER_MINUTE;
  if (minutesLeft >= MINUTES_TO_MEET_FIRST_REAL_READING) return modelledC;
  const realShare = 1 - minutesLeft / MINUTES_TO_MEET_FIRST_REAL_READING;
  return (
    modelledC + (probe.firstRealReading.temperature - modelledC) * realShare
  );
}

function simulateHumidity(temperature, random) {
  const humidity =
    HUMIDITY_AT_MILDEST_LOW_PCT +
    (MILDEST_NIGHT_LOW_C - temperature) * HUMIDITY_PCT_PER_DEGREE_COLDER +
    spread(HUMIDITY_NOISE_RANGE_PCT, random);
  return roundTo(
    Math.min(HIGHEST_HUMIDITY_PCT, Math.max(LOWEST_HUMIDITY_PCT, humidity)),
    1,
  );
}

function simulateCo2(nightness, random) {
  return Math.round(
    AFTERNOON_CO2_PPM +
      PRE_DAWN_CO2_RISE_PPM * nightness +
      spread(CO2_NOISE_RANGE_PPM, random),
  );
}

/**
 * The zone's temperature through a window, eased between the coldest point before dawn and the
 * warmest in mid-afternoon. `nightness` is 0 at the afternoon high and 1 at the pre-dawn low.
 */
export function buildClimate({ timezone, from, until, now }) {
  const extremes = listExtremes(timezone, from, until, now);
  return (instant) => {
    const instantMs = instant.getTime();
    const nextIndex = extremes.findIndex((extreme) => extreme.atMs > instantMs);
    const previous = extremes[nextIndex - 1];
    const next = extremes[nextIndex];
    const progress = (instantMs - previous.atMs) / (next.atMs - previous.atMs);
    const eased = (1 - Math.cos(Math.PI * progress)) / 2;
    const temperature =
      previous.temperature + (next.temperature - previous.temperature) * eased;
    const isCooling = previous.temperature > next.temperature;
    return { temperature, nightness: isCooling ? eased : 1 - eased };
  };
}

// From the afternoon before the window to the dawn after it, so every instant sits between two.
function listExtremes(timezone, from, until, now) {
  const lastDay = startOfLocalDay(until, timezone).plus({ days: 1 });
  const extremes = [];
  for (
    let day = startOfLocalDay(from, timezone).minus({ days: 1 });
    day <= lastDay;
    day = day.plus({ days: 1 })
  ) {
    extremes.push(coldestOf(day, now), warmestOf(day, now));
  }
  return extremes;
}

// Dawn ends the night whose evening was the day before.
function coldestOf(day, now) {
  const coldness = findNightColdness(countDaysAgo(day, now) + 1);
  return {
    atMs: day.set(COLDEST_AT).toMillis(),
    temperature: interpolate(
      MILDEST_NIGHT_LOW_C,
      FREEZING_NIGHT_LOW_C,
      coldness,
    ),
  };
}

// An afternoon is cooler when the night after it is colder.
function warmestOf(day, now) {
  const coldness = findNightColdness(countDaysAgo(day, now));
  return {
    atMs: day.set(WARMEST_AT).toMillis(),
    temperature: interpolate(
      WARMEST_AFTERNOON_C,
      COLDEST_AFTERNOON_C,
      coldness,
    ),
  };
}

function interpolate(from, to, share) {
  return from + (to - from) * share;
}

function spread(range, random) {
  return (random() - 0.5) * range;
}

function roundTo(value, decimals) {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
