import type { MigrationInterface } from 'typeorm';

const TRAILING_TIMESTAMP = /\d+$/;

export type MigrationClass = new () => MigrationInterface;

// TypeORM orders and records a migration by the timestamp ending its name.
export function readMigrationTimestamp(migrationName: string): number {
  return Number(TRAILING_TIMESTAMP.exec(migrationName)?.[0]);
}
