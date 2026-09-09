import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A node's bootId changes on every restart of its agent. Persisted rather than
 * held in memory so that a node bounce is still detectable across a restart of
 * the server, which is when the pin state most needs re-asserting.
 */
export class AddNodeBootId1788923106173 implements MigrationInterface {
    name = 'AddNodeBootId1788923106173'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "nodes" ADD "boot_id" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "boot_id"`);
    }

}
