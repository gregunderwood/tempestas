#!/usr/bin/env node
// Writes 30 days of simulated temperature readings for every probe in a dev or screenshot database.
// When and how to use it: docs/Testing.md.
import {
  DEVELOPMENT_DATABASE_CONTAINER,
  DEVELOPMENT_DATABASE_RULE,
} from './lib/development-database.mjs';
import {
  explainDevelopmentDatabaseRefusal,
  readJson,
  runSql,
} from './lib/development-database-psql.mjs';
import {
  DEFAULT_TIMEZONE,
  findHistoryStart,
  HISTORY_DAYS,
} from './lib/history-window.mjs';
import {
  buildFindFirstRealReadingsSql,
  buildFindProbesSql,
  buildReplaceReadingsSql,
  SEEDED_BOOT_ID,
} from './lib/reading-history-sql.mjs';
import {
  buildSimulatedReadings,
  READING_INTERVAL_MINUTES,
} from './lib/simulated-readings.mjs';

const USAGE = `Usage: tools/seed-reading-history.mjs <database>

Writes ${HISTORY_DAYS} days of sensor_readings, one every ${READING_INTERVAL_MINUTES} minute, for every probe that has
reported in <database>, in the ${DEVELOPMENT_DATABASE_CONTAINER} container. Coldest before dawn and warmest
mid-afternoon in the zone's timezone, with the same cold nights the runtime history heats through,
two of them near 0 °C. Each probe's seed ends at its first real reading in the window, and its rows
carry boot_id '${SEEDED_BOOT_ID}', so a rerun replaces only them and never touches a real reading.

${DEVELOPMENT_DATABASE_RULE}`;

try {
  main();
} catch (error) {
  fail(error.message);
}

function main() {
  const databaseName = parseArguments(process.argv.slice(2));
  requireDevelopmentDatabase(databaseName);
  const now = new Date();
  const probes = readProbesWithRealReadings(databaseName, now);
  if (probes.length === 0) {
    fail(
      `${databaseName} has no probe with a reading in the last ${HISTORY_DAYS} days to seed.`,
    );
  }
  const probeReadings = buildSimulatedReadings({ probes, now });
  runSql(databaseName, buildReplaceReadingsSql(probeReadings));
  describeWhatWasWritten(databaseName, probeReadings);
}

function parseArguments(argumentsAfterScript) {
  if (
    argumentsAfterScript.length !== 1 ||
    argumentsAfterScript[0].startsWith('-')
  ) {
    console.error(USAGE);
    process.exit(2);
  }
  return argumentsAfterScript[0];
}

function requireDevelopmentDatabase(databaseName) {
  const refusal = explainDevelopmentDatabaseRefusal(databaseName);
  if (refusal) fail(`${refusal}\n\n${USAGE}`);
}

function readProbesWithRealReadings(databaseName, now) {
  const probes = readJson(databaseName, buildFindProbesSql(DEFAULT_TIMEZONE));
  if (probes.length === 0) return [];
  const probeStarts = probes.map((probe) => ({
    probe,
    historyStart: findHistoryStart(now, probe.timezone),
  }));
  const firstRealReadings = readJson(
    databaseName,
    buildFindFirstRealReadingsSql(probeStarts),
  );
  return probes.flatMap((probe) => {
    const firstRealReading = firstRealReadings.find(
      (reading) =>
        reading.nodeUuid === probe.nodeUuid &&
        reading.sensorId === probe.sensorId,
    );
    if (!firstRealReading) return [];
    return [
      {
        ...probe,
        firstRealReading: {
          at: new Date(firstRealReading.at),
          temperature: firstRealReading.temperature,
        },
      },
    ];
  });
}

function describeWhatWasWritten(databaseName, probeReadings) {
  for (const { probe, rows } of probeReadings) {
    console.log(
      `seed-reading-history: ${probe.nodeId}/${probe.sensorId}: ${rows.length} readings, up to its first real one at ${probe.firstRealReading.at.toISOString()}.`,
    );
  }
  const rowCount = probeReadings.reduce(
    (total, readings) => total + readings.rows.length,
    0,
  );
  console.log(
    `seed-reading-history: wrote ${rowCount} readings for ${probeReadings.length} probe(s) in ${databaseName}.`,
  );
}

function fail(reason) {
  console.error(`seed-reading-history: ${reason}`);
  process.exit(1);
}
