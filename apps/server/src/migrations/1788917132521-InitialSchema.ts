import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1788917132521 implements MigrationInterface {
  name = 'InitialSchema1788917132521';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."nodes_kind_enum" AS ENUM('rpi', 'esp32', 'virtual')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."nodes_status_enum" AS ENUM('pending', 'admitted', 'disabled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "nodes" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "slug" text NOT NULL, "display_name" text NOT NULL, "location" text, "kind" "public"."nodes_kind_enum" NOT NULL DEFAULT 'rpi', "status" "public"."nodes_status_enum" NOT NULL DEFAULT 'pending', "capabilities" jsonb NOT NULL, "agent_version" text, "online" boolean NOT NULL DEFAULT false, "last_seen_at" TIMESTAMP WITH TIME ZONE, "zone_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_d37ec63e15d0e50b5ec07c48918" UNIQUE ("slug"), CONSTRAINT "PK_682d6427523a0fa43d062ea03ee" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_74856822978d9ecdb2c9c4e4e6" ON "nodes" ("zone_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "zones" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "slug" text NOT NULL, "display_name" text NOT NULL, "rules_config" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_ce0bfaeb58d504e4ed3a70d5d59" UNIQUE ("slug"), CONSTRAINT "PK_880484a43ca311707b05895bd4a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "sensor_readings" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "node_id" uuid NOT NULL, "sensor_id" text NOT NULL, "temperature" double precision NOT NULL, "humidity" double precision NOT NULL, "co2" integer, "node_seq" bigint, "node_ts" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_readings_node_sensor_seq" UNIQUE ("node_id", "sensor_id", "node_seq"), CONSTRAINT "PK_ae97fcc8df9e5662d9d007d102b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_readings_node_created_at" ON "sensor_readings" ("node_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_readings_created_at" ON "sensor_readings" ("created_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."devices_role_enum" AS ENUM('lights', 'co2_generator', 'exhaust_fan')`,
    );
    await queryRunner.query(
      `CREATE TABLE "devices" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "node_id" uuid NOT NULL, "zone_id" uuid NOT NULL, "name" text NOT NULL, "description" text, "gpio" integer NOT NULL, "on_delay_duration" integer NOT NULL DEFAULT '0', "on_at" TIMESTAMP WITH TIME ZONE, "off_at" TIMESTAMP WITH TIME ZONE, "on_level" smallint NOT NULL DEFAULT '1', "rules_enabled" boolean NOT NULL DEFAULT true, "role" "public"."devices_role_enum", "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_devices_node_gpio" UNIQUE ("node_id", "gpio"), CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_devices_zone_role" ON "devices" ("zone_id", "role") `,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" ADD CONSTRAINT "FK_74856822978d9ecdb2c9c4e4e6e" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" ADD CONSTRAINT "FK_9d7751c7d4339983b4ffa27a416" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "FK_e2b2d5426c168eda6161791c8b2" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD CONSTRAINT "FK_ac1913e94e4175208eb5d21b9a1" FOREIGN KEY ("zone_id") REFERENCES "zones"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT "FK_ac1913e94e4175208eb5d21b9a1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" DROP CONSTRAINT "FK_e2b2d5426c168eda6161791c8b2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sensor_readings" DROP CONSTRAINT "FK_9d7751c7d4339983b4ffa27a416"`,
    );
    await queryRunner.query(
      `ALTER TABLE "nodes" DROP CONSTRAINT "FK_74856822978d9ecdb2c9c4e4e6e"`,
    );
    await queryRunner.query(`DROP INDEX "public"."ix_devices_zone_role"`);
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP TYPE "public"."devices_role_enum"`);
    await queryRunner.query(`DROP INDEX "public"."ix_readings_created_at"`);
    await queryRunner.query(
      `DROP INDEX "public"."ix_readings_node_created_at"`,
    );
    await queryRunner.query(`DROP TABLE "sensor_readings"`);
    await queryRunner.query(`DROP TABLE "zones"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_74856822978d9ecdb2c9c4e4e6"`,
    );
    await queryRunner.query(`DROP TABLE "nodes"`);
    await queryRunner.query(`DROP TYPE "public"."nodes_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."nodes_kind_enum"`);
  }
}
