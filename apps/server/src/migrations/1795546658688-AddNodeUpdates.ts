import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNodeUpdates1795546658688 implements MigrationInterface {
  name = 'AddNodeUpdates1795546658688';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "node_updates" (
        "id"           uuid        PRIMARY KEY,
        "node_id"      uuid        NOT NULL,
        "app"          text        NOT NULL,
        "from_version" text,
        "to_version"   text        NOT NULL,
        "is_roll_back" boolean     NOT NULL,
        "last_state"   text,
        "outcome"      text        NOT NULL,
        "reason"       text,
        "started_at"   timestamptz NOT NULL,
        "finished_at"  timestamptz,
        CONSTRAINT "fk_node_updates_node" FOREIGN KEY ("node_id")
          REFERENCES "nodes" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_node_updates_node_started"
        ON "node_updates" ("node_id", "started_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "node_updates"`);
  }
}
