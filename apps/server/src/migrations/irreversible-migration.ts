import type { MigrationInterface, QueryRunner } from 'typeorm';

export abstract class IrreversibleMigration implements MigrationInterface {
  abstract readonly name: string;
  abstract readonly irreversibleBecause: string;

  abstract up(queryRunner: QueryRunner): Promise<void>;

  async down(): Promise<void> {
    throw new Error(
      `${this.name} cannot be reverted: ${this.irreversibleBecause}. ` +
        `If the deploy being rolled back applied it, restore that deploy's backup; ` +
        `otherwise fix forward with a new migration`,
    );
  }
}

export function isIrreversible(
  migration: MigrationInterface,
): migration is IrreversibleMigration {
  return migration instanceof IrreversibleMigration;
}
