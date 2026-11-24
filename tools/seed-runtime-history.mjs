#!/usr/bin/env node
// Writes 30 days of simulated on/off history for every device in a dev or screenshot database.
// When and how to use it: docs/Testing.md.
import { spawnSync } from 'node:child_process';
import {
  buildSimulatedHistory,
  HISTORY_DAYS,
} from './lib/simulated-runtime-history.mjs';

const DATABASE_CONTAINER = 'tempestas-db';
const DATABASE_USER = 'tempestas';
const PRODUCTION_DATABASE = 'tempestas';
const DEVELOPMENT_DATABASE_PATTERN =
  /^tempestas_(dev|pr_[0-9]+_(before|after))(_[a-z0-9]+)*$/;
const DEFAULT_TIMEZONE = 'America/Vancouver';
const ROWS_PER_INSERT = 500;
const USAGE = `Usage: tools/seed-runtime-history.mjs <database>

Replaces the last ${HISTORY_DAYS} days of pin_transitions for every device in <database>, in the
${DATABASE_CONTAINER} container, with simulated history, and moves each device's created_at back to
its start. Heaters run more at night, one day short-cycles, and one node drops out for a few hours.
Rerunning replaces the same window again, so it never doubles the history.

<database> must be a dev or screenshot database: tempestas_dev, tempestas_dev_<suffix> or
tempestas_pr_<n>_before|after. Production's name, ${PRODUCTION_DATABASE}, is always refused, and so
is the dev database of that name: copy it first with
  docker exec ${DATABASE_CONTAINER} createdb -U ${DATABASE_USER} -T tempestas tempestas_dev`;

main();

function main() {
  const databaseName = parseArguments(process.argv.slice(2));
  requireDevelopmentDatabase(databaseName);
  const lines = readDeviceLines(databaseName);
  if (lines.length === 0) {
    fail(`${databaseName} has no devices to give history to.`);
  }
  const histories = buildSimulatedHistory({ lines, now: new Date() });
  runSql(databaseName, buildReplaceHistorySql(histories));
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
  if (databaseName === PRODUCTION_DATABASE) {
    fail(
      `refusing ${databaseName}: it is production's name. Seed a copy named tempestas_dev instead.`,
    );
  }
  if (!DEVELOPMENT_DATABASE_PATTERN.test(databaseName)) {
    fail(
      `refusing ${databaseName}: not a dev or screenshot database name.\n\n${USAGE}`,
    );
  }
}

function readDeviceLines(databaseName) {
  const json = runSql(
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
  return JSON.parse(json);
}

function buildReplaceHistorySql(histories) {
  const statements = ['begin;'];
  for (const { line, historyStart, rows } of histories) {
    const windowEnd = rows.at(-1).observedAt;
    statements.push(
      `delete from pin_transitions where node_id = ${quote(line.nodeId)} and pin = ${line.pin}` +
        ` and observed_at between ${quoteInstant(historyStart)} and greatest(now(), ${quoteInstant(windowEnd)});`,
      `update devices set created_at = least(created_at, ${quoteInstant(historyStart)})` +
        ` where id = ${quote(line.deviceId)};`,
    );
  }
  const allRows = histories.flatMap((history) => history.rows);
  for (let index = 0; index < allRows.length; index += ROWS_PER_INSERT) {
    statements.push(buildInsert(allRows.slice(index, index + ROWS_PER_INSERT)));
  }
  statements.push('commit;');
  return statements.join('\n');
}

function buildInsert(rows) {
  const values = rows.map(
    (row) =>
      `(${quote(row.nodeId)}, ${row.pin}, ${row.level ?? 'null'}, ${row.known}, ${row.energised ?? 'null'}, ` +
      `${quote(row.deviceId)}, ${row.role === null ? 'null' : quote(row.role)}, ${quote(row.reason)}, ` +
      `${quoteInstant(row.observedAt)})`,
  );
  return (
    'insert into pin_transitions (node_id, pin, level, known, energised, device_id, role, reason, observed_at) values\n' +
    values.join(',\n') +
    ';'
  );
}

function quote(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

function quoteInstant(instant) {
  return `${quote(instant.toISOString())}::timestamptz`;
}

function runSql(databaseName, sql, psqlOptions = []) {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      DATABASE_CONTAINER,
      'psql',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      DATABASE_USER,
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
