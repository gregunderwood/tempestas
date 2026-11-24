import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDeviceInputBtuPerHour1795488489699 implements MigrationInterface {
  name = 'AddDeviceInputBtuPerHour1795488489699';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" ADD "input_btu_per_hour" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" DROP COLUMN "input_btu_per_hour"`,
    );
  }
}
