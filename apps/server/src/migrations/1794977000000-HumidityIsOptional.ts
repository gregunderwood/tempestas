import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let a reading have no humidity.
 *
 * A DS18B20 measures temperature only. With humidity NOT NULL the server had to
 * drop every pumphouse sample whole - temperature included - because of a
 * value no rule ever reads. CO2 already worked this way: null means unknown.
 *
 * `down` fails with Postgres's own error if any humidity-less row exists. That
 * is deliberate: the alternative is deleting real temperature history.
 */
export class HumidityIsOptional1794977000000 implements MigrationInterface {
  name = 'HumidityIsOptional1794977000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" ALTER COLUMN "humidity" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" ALTER COLUMN "humidity" SET NOT NULL`,
    );
  }
}
