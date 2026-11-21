import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';

// The major version elantris runs; a schema dump differs between majors.
const POSTGRES_IMAGE = 'postgres:17';
const POSTGRES_PORT = '5432';
export const SUPERUSER = 'postgres';
const SUPERUSER_PASSWORD = 'round-trip-superuser';
const APPLICATION_ROLE = 'tempestas';
const APPLICATION_PASSWORD = 'round-trip';
const OWNER_PID_LABEL = 'tempestas.migration-round-trip.owner-pid';
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
  removeAbandonedContainers();
  pullImageIfMissing();
  const containerId = runDocker(
    'run',
    '--detach',
    '--rm',
    '--label',
    `${OWNER_PID_LABEL}=${process.pid}`,
    '--publish',
    `127.0.0.1::${POSTGRES_PORT}`,
    '--env',
    `POSTGRES_PASSWORD=${SUPERUSER_PASSWORD}`,
    POSTGRES_IMAGE,
  );
  const removeContainer = () => runDocker('rm', '--force', containerId);

  try {
    await waitUntilAcceptingConnections(containerId);
    createApplicationDatabase(containerId);
    project.provide('throwawayPostgres', {
      containerId,
      port: readPublishedPort(containerId),
      username: APPLICATION_ROLE,
      password: APPLICATION_PASSWORD,
      database: APPLICATION_ROLE,
    });
  } catch (startupError) {
    removeContainer();
    throw startupError;
  }
  return removeContainer;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (signalError) {
    return (signalError as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Left behind when a run is interrupted before its teardown; a live owner's container is left alone.
function removeAbandonedContainers() {
  const listing = runDocker(
    'ps',
    '--all',
    '--filter',
    `label=${OWNER_PID_LABEL}`,
    '--format',
    `{{.ID}} {{.Label "${OWNER_PID_LABEL}"}}`,
  );
  for (const line of listing.split('\n').filter(Boolean)) {
    const [containerId, ownerPid] = line.split(' ');
    if (!isProcessRunning(Number(ownerPid))) {
      runDocker('rm', '--force', containerId);
    }
  }
}

function pullImageIfMissing() {
  try {
    runDocker('image', 'inspect', POSTGRES_IMAGE);
  } catch {
    console.log(`Pulling ${POSTGRES_IMAGE} for the migration round trip`);
    runDocker('pull', '--quiet', POSTGRES_IMAGE);
  }
}

// Production connects as an owner that is not a superuser, so a migration needing superuser fails here too.
function createApplicationDatabase(containerId: string) {
  runDocker(
    'exec',
    containerId,
    'psql',
    '--username',
    SUPERUSER,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `CREATE ROLE ${APPLICATION_ROLE} LOGIN NOSUPERUSER PASSWORD '${APPLICATION_PASSWORD}'`,
    '--command',
    `CREATE DATABASE ${APPLICATION_ROLE} OWNER ${APPLICATION_ROLE}`,
  );
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
