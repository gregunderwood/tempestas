import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';

// The major version elantris runs; a schema dump differs between majors.
const POSTGRES_IMAGE = 'postgres:17';
const POSTGRES_PORT = '5432';
const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'round-trip';
const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_MS = 250;

export interface ThrowawayPostgres {
  containerId: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    throwawayPostgres: ThrowawayPostgres;
  }
}

export function runDocker(...dockerArguments: string[]): string {
  return execFileSync('docker', dockerArguments, { encoding: 'utf8' }).trim();
}

export default async function startThrowawayPostgres(project: TestProject) {
  const containerId = runDocker(
    'run',
    '--detach',
    '--rm',
    '--publish',
    `127.0.0.1::${POSTGRES_PORT}`,
    '--env',
    `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
    POSTGRES_IMAGE,
  );
  const removeContainer = () => runDocker('rm', '--force', containerId);

  try {
    await waitUntilAcceptingConnections(containerId);
    project.provide('throwawayPostgres', {
      containerId,
      port: readPublishedPort(containerId),
      username: SUPERUSER,
      password: SUPERUSER_PASSWORD,
      database: SUPERUSER,
    });
  } catch (startupError) {
    removeContainer();
    throw startupError;
  }
  return removeContainer;
}

function readPublishedPort(containerId: string): number {
  const published = runDocker('port', containerId, POSTGRES_PORT);
  return Number(published.split('\n')[0].split(':').pop());
}

// Over TCP: the image's first-boot server listens on the socket only, then restarts.
function isAcceptingConnections(containerId: string): boolean {
  try {
    runDocker(
      'exec',
      containerId,
      'pg_isready',
      '--host',
      '127.0.0.1',
      '--username',
      SUPERUSER,
    );
    return true;
  } catch {
    return false;
  }
}

async function waitUntilAcceptingConnections(containerId: string) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (!isAcceptingConnections(containerId)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Postgres in ${containerId} was not ready within ${READINESS_TIMEOUT_MS} ms`,
      );
    }
    await wait(READINESS_POLL_MS);
  }
}
