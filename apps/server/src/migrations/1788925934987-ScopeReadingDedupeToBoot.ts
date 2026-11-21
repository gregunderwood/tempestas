import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A node's sequence counter restarts at 1 when its agent restarts, so keying
 * the QoS-1 dedupe on (node, sensor, seq) alone silently dropped every sample
 * after a node reboot until the counter passed its previous high-water mark.
 * The symptom was indistinguishable from a stale sensor.
 *
 * Note the `down`: the narrower constraint cannot hold rows from two boots that
 * share a (node, sensor, seq), so it refuses and counts them rather than
 * deleting readings. On a populated database this revert is not guaranteed.
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
    const [{ repeated }]: { repeated: number }[] = await queryRunner.query(`
      SELECT count(*)::int AS repeated FROM (
        SELECT 1 FROM sensor_readings WHERE node_seq IS NOT NULL
        GROUP BY node_id, sensor_id, node_seq HAVING count(*) > 1
      ) AS repeats
    `);
    if (repeated > 0) {
      throw new Error(
        `Sequence numbers repeated across boots: ${repeated}. The old constraint cannot hold them ` +
          `without deleting readings; restore the backup taken before this migration instead`,
      );
    }
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
