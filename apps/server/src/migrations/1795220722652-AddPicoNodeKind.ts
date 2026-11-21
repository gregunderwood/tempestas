import { MigrationInterface, QueryRunner } from 'typeorm';

/** Postgres cannot drop an enum value, so `down` rebuilds the type that `up` only extends. */
export class AddPicoNodeKind1795220722652 implements MigrationInterface {
  name = 'AddPicoNodeKind1795220722652';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."nodes_kind_enum" ADD VALUE IF NOT EXISTS 'pico' BEFORE 'virtual'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const picoNodes: { slug: string }[] = await queryRunner.query(
      `SELECT slug FROM nodes WHERE kind = 'pico'`,
    );
    if (picoNodes.length > 0) {
      throw new Error(
        `Nodes are still Picos (${picoNodes.map((node) => node.slug).join(', ')}). ` +
          `Reverting would mean deleting them and their readings. ` +
          `If the deploy being rolled back applied this migration, restore that deploy's backup; ` +
          `otherwise fix forward with a new migration`,
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."nodes_kind_enum" RENAME TO "nodes_kind_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."nodes_kind_enum" AS ENUM('rpi', 'esp32', 'virtual')`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ALTER COLUMN "kind" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ALTER COLUMN "kind" TYPE "public"."nodes_kind_enum" USING "kind"::"text"::"public"."nodes_kind_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ALTER COLUMN "kind" SET DEFAULT 'rpi'`,
    );
    await queryRunner.query(`DROP TYPE "public"."nodes_kind_enum_old"`);
  }
}
