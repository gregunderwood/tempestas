import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeAgentName1795330000000 implements MigrationInterface {
  name = 'AddNodeAgentName1795330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "nodes" ADD "agent_name" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "nodes" DROP COLUMN "agent_name"`);
  }
}
