#!/usr/bin/env node
// Writes 30 days of simulated on/off history for every device in a dev or screenshot database.
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
import { DEFAULT_TIMEZONE, HISTORY_DAYS } from './lib/history-window.mjs';
import { readProbesWithRealReadings } from './lib/probes-psql.mjs';
import { buildReplaceHistorySql } from './lib/runtime-history-sql.mjs';
import { buildSimulatedHistory } from './lib/simulated-runtime-history.mjs';
import {
  FAULT_NIGHT_DAYS_AGO,
  THERMOSTAT_ROLES,
} from './lib/simulated-thermostat.mjs';

const USAGE = `Usage: tools/seed-runtime-history.mjs <database>

Replaces the last ${HISTORY_DAYS} days of pin_transitions for every device in <database>, in the
${DEVELOPMENT_DATABASE_CONTAINER} container, with simulated history, and moves each device's created_at back to
its start. A heater or heat tape switches by its zone's simulated temperatures, the same ones
tools/seed-reading-history.mjs writes, and its rule's setpoints and on delay, so run it once the
stack has its first real readings. The night ${FAULT_NIGHT_DAYS_AGO} days ago, one of them fails to come on. Other
roles run by a daily pattern; one day short-cycles, and one node drops out for a few hours.
Rerunning replaces the same window again, so it never doubles the history.

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
  const lines = readDeviceLines(databaseName);
  if (lines.length === 0) {
    fail(`${databaseName} has no devices to give history to.`);
  }
  const probes = readProbesWithRealReadings(databaseName, now);
  const histories = buildSimulatedHistory({ lines, probes, now });
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
  const refusal = explainDevelopmentDatabaseRefusal(databaseName);
  if (refusal) fail(`${refusal}\n\n${USAGE}`);
}

function readDeviceLines(databaseName) {
  return readJson(
    databaseName,
    `select coalesce(json_agg(line order by line."nodeId", line.pin), '[]')
     from (
       select device.id as "deviceId", node.slug as "nodeId", device.gpio as pin,
              device.on_level as "onLevel", device.role::text as role,
              device.on_delay_duration as "onDelaySeconds", zone.id as "zoneId",
              zone.rules_config as "rulesConfig",
              coalesce(zone.rules_config->>'timezone', '${DEFAULT_TIMEZONE}') as timezone,
              (select json_build_object('level', latest.level, 'known', latest.known)
                 from pin_transitions latest
                where latest.node_id = node.slug and latest.pin = device.gpio
                order by latest.observed_at desc limit 1) as "currentState"
         from devices device
         join nodes node on node.id = device.node_id
         join zones zone on zone.id = device.zone_id
     ) line`,
  );
}

function describeWhatWasWritten(databaseName, histories) {
  const rowCount = histories.reduce(
    (total, history) => total + history.rows.length,
    0,
  );
  for (const { line, isFollowingThermostat } of histories) {
    if (isFollowingThermostat) {
      console.log(
        `seed-runtime-history: ${line.nodeId}/${line.pin} (${line.role}) follows its zone's simulated temperatures.`,
      );
    } else if (THERMOSTAT_ROLES.includes(line.role)) {
      console.log(
        `seed-runtime-history: ${line.nodeId}/${line.pin} (${line.role}) has no heat thermostat with a reporting probe to follow, so it runs by the night pattern.`,
      );
    }
  }
  console.log(
    `seed-runtime-history: wrote ${rowCount} rows of ${HISTORY_DAYS} days' history for ${histories.length} device(s) in ${databaseName}.`,
  );
}

function fail(reason) {
  console.error(`seed-runtime-history: ${reason}`);
  process.exit(1);
}
