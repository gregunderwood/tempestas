import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record every relay line change, so the greenhouse can be fitted rather than
 * guessed at.
 *
 * `devices` holds only the current `onAt`/`offAt`, so each change erases the
 * one before it. Refitting the burner model therefore had to infer relay state
 * from the CO2 curve that state was meant to explain, and gross output,
 * transport lag and removal could not be separated: the grid search moved gross
 * between 88 and 118 ppm/min depending only on how the trajectory was anchored.
 *
 * Small by construction - a few hundred rows a day at most - and deliberately
 * NOT covered by the readings retention job. The readings are a measurement the
 * greenhouse will make again tomorrow; a relay transition happened once.
 */
export class AddPinTransitions1789170000000 implements MigrationInterface {
  name = 'AddPinTransitions1789170000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pin_transitions" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "node_id"     text        NOT NULL,
        "pin"         integer     NOT NULL,
        "level"       smallint,
        "known"       boolean     NOT NULL,
        "energised"   boolean,
        "device_id"   uuid,
        "role"        text,
        "reason"      text        NOT NULL,
        "observed_at" timestamptz NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_pin_transitions_line_time"
        ON "pin_transitions" ("node_id", "pin", "observed_at")
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_pin_transitions_time"
        ON "pin_transitions" ("observed_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pin_transitions"`);
  }
}
