import type { MigrationInterface, QueryRunner } from 'typeorm';

export abstract class IrreversibleMigration implements MigrationInterface {
  abstract readonly name: string;
  abstract readonly irreversibleBecause: string;

  abstract up(queryRunner: QueryRunner): Promise<void>;

  async down(): Promise<void> {
    throw new Error(
      `${this.name} cannot be reverted: ${this.irreversibleBecause}. Restore the backup taken before it ran.`,
    );
  }
}

export function isIrreversible(
  migration: MigrationInterface,
): migration is IrreversibleMigration {
  return migration instanceof IrreversibleMigration;
}
