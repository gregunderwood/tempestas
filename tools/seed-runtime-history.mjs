#!/usr/bin/env node
// Writes 30 days of simulated on/off history for every device in a dev or screenshot database.
// When and how to use it: docs/Testing.md.
import { spawnSync } from 'node:child_process';
import {
  DEVELOPMENT_DATABASE_CONTAINER,
  DEVELOPMENT_DATABASE_RULE,
  DEVELOPMENT_DATABASE_USER,
  explainDatabaseRefusal,
} from './lib/development-database.mjs';
import { buildReplaceHistorySql } from './lib/runtime-history-sql.mjs';
import {
  buildSimulatedHistory,
  HISTORY_DAYS,
} from './lib/simulated-runtime-history.mjs';

const DEFAULT_TIMEZONE = 'America/Vancouver';
const USAGE = `Usage: tools/seed-runtime-history.mjs <database>

Replaces the last ${HISTORY_DAYS} days of pin_transitions for every device in <database>, in the
${DEVELOPMENT_DATABASE_CONTAINER} container, with simulated history, and moves each device's created_at back to
its start. Heaters run more at night, one day short-cycles, and one node drops out for a few hours.
Rerunning replaces the same window again, so it never doubles the history.

${DEVELOPMENT_DATABASE_RULE}`;

main();

function main() {
  const databaseName = parseArguments(process.argv.slice(2));
  requireDevelopmentDatabase(databaseName);
  const now = new Date();
  const lines = readDeviceLines(databaseName);
  if (lines.length === 0) {
    fail(`${databaseName} has no devices to give history to.`);
  }
  const histories = buildSimulatedHistory({ lines, now });
  runSql(databaseName, buildReplaceHistorySql({ histories, now }));
  describeWhatWasWritten(databaseName, histories);
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
  const refusal = explainDatabaseRefusal(databaseName, readContainerLabels());
  if (refusal) fail(`${refusal}\n\n${USAGE}`);
}

function readContainerLabels() {
  const result = spawnSync(
    'docker',
    [
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      DEVELOPMENT_DATABASE_CONTAINER,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function readDeviceLines(databaseName) {
  const deviceLinesJson = runSql(
    databaseName,
    `select coalesce(json_agg(line order by line."nodeId", line.pin), '[]')
     from (
       select device.id as "deviceId", node.slug as "nodeId", device.gpio as pin,
              device.on_level as "onLevel", device.role::text as role,
              coalesce(zone.rules_config->>'timezone', '${DEFAULT_TIMEZONE}') as timezone,
              (select json_build_object('level', latest.level, 'known', latest.known)
                 from pin_transitions latest
                where latest.node_id = node.slug and latest.pin = device.gpio
                order by latest.observed_at desc limit 1) as "currentState"
         from devices device
         join nodes node on node.id = device.node_id
         join zones zone on zone.id = device.zone_id
     ) line`,
    ['-tAX'],
  );
  return JSON.parse(deviceLinesJson);
}

function runSql(databaseName, sql, psqlOptions = []) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      DEVELOPMENT_DATABASE_CONTAINER,
      'psql',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      DEVELOPMENT_DATABASE_USER,
      '-d',
      databaseName,
      ...psqlOptions,
    ],
    { input: sql, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    fail(`psql failed on ${databaseName}: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

function describeWhatWasWritten(databaseName, histories) {
  const rowCount = histories.reduce(
    (total, history) => total + history.rows.length,
    0,
  );
  console.log(
    `seed-runtime-history: wrote ${rowCount} rows of ${HISTORY_DAYS} days' history for ${histories.length} device(s) in ${databaseName}.`,
  );
}

function fail(reason) {
  console.error(`seed-runtime-history: ${reason}`);
  process.exit(1);
}
