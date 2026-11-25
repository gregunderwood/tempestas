// Talks to the dev database container through docker exec and psql, after its name passes the guard.
import { spawnSync } from 'node:child_process';
import {
  DEVELOPMENT_DATABASE_CONTAINER,
  DEVELOPMENT_DATABASE_USER,
  explainDatabaseRefusal,
} from './development-database.mjs';

const PSQL_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

export function explainDevelopmentDatabaseRefusal(databaseName) {
  return explainDatabaseRefusal(databaseName, readContainerLabels());
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

export function runSql(databaseName, sql, psqlOptions = []) {
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
    { input: sql, encoding: 'utf8', maxBuffer: PSQL_OUTPUT_LIMIT_BYTES },
  );
  if (result.status !== 0) {
    throw new Error(
      `psql failed on ${databaseName}: ${result.stderr || result.error}`,
    );
  }
  return result.stdout;
}

export function readJson(databaseName, sql) {
  return JSON.parse(runSql(databaseName, sql, ['-tAX']));
}
