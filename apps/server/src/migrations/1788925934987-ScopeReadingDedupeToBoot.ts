import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A node's sequence counter restarts at 1 when its agent restarts, so keying
 * the QoS-1 dedupe on (node, sensor, seq) alone silently dropped every sample
 * after a node reboot until the counter passed its previous high-water mark.
 * The symptom was indistinguishable from a stale sensor.
 *
 * Note the `down`: re-adding the narrower constraint will fail if rows from two
 * boots now share a (node, sensor, seq). That is the correct behaviour - it
 * refuses rather than deleting readings - but it means this revert is not
 * guaranteed on a populated database.
 */
export class ScopeReadingDedupeToBoot1788925934987 implements MigrationInterface {
  name = 'ScopeReadingDedupeToBoot1788925934987';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" DROP CONSTRAINT "uq_readings_node_sensor_seq"`,
    );
    await queryRunner.query(`ALTER TABLE "sensor_readings" ADD "boot_id" text`);
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" ADD CONSTRAINT "uq_readings_node_sensor_boot_seq" UNIQUE ("node_id", "sensor_id", "boot_id", "node_seq")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" DROP CONSTRAINT "uq_readings_node_sensor_boot_seq"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" DROP COLUMN "boot_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" ADD CONSTRAINT "uq_readings_node_sensor_seq" UNIQUE ("node_id", "sensor_id", "node_seq")`,
    );
  }
}
