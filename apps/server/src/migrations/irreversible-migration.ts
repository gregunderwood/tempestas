import type { MigrationInterface } from 'typeorm';

export interface IrreversibleMigration extends MigrationInterface {
  readonly irreversibleBecause: string;
}

export function isIrreversible(
  migration: MigrationInterface,
): migration is IrreversibleMigration {
  return 'irreversibleBecause' in migration;
}
