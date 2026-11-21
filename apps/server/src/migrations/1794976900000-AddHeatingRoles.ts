import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Teach the database the `heater` and `heat_tape` roles.
 *
 * `devices.role` is a Postgres enum, so adding the roles to `DeviceRole` in
 * code was not enough: creating a pumphouse heater device would have failed at
 * the database. `migration:generate` is what noticed.
 *
 * `ADD VALUE` rather than the generator's rename-and-recreate: it is one
 * statement, rewrites nothing, and leaves `ix_devices_zone_role` alone.
 *
 * Postgres cannot drop an enum value, so `down` rebuilds the type without them -
 * and refuses while any device still has one of these roles, rather than
 * deleting a heater's row to make the revert go through.
 */
export class AddHeatingRoles1794976900000 implements MigrationInterface {
  name = 'AddHeatingRoles1794976900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."devices_role_enum" ADD VALUE IF NOT EXISTS 'heater'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."devices_role_enum" ADD VALUE IF NOT EXISTS 'heat_tape'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const inUse: { name: string }[] = await queryRunner.query(
      `SELECT name FROM devices WHERE role IN ('heater', 'heat_tape')`,
    );
    if (inUse.length > 0) {
      throw new Error(
        `Devices still use the heating roles (${inUse.map((device) => device.name).join(', ')}). ` +
          `Reverting would mean deleting them or giving a heater a role its rules would drive wrongly. ` +
          `If the deploy being rolled back applied this migration, restore that deploy's backup; ` +
          `otherwise fix forward with a new migration`,
      );
    }
    await queryRunner.query(`DROP INDEX "public"."ix_devices_zone_role"`);
    await queryRunner.query(
      `ALTER TYPE "public"."devices_role_enum" RENAME TO "devices_role_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."devices_role_enum" AS ENUM('lights', 'co2_generator', 'exhaust_fan')`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ALTER COLUMN "role" TYPE "public"."devices_role_enum" USING "role"::"text"::"public"."devices_role_enum"`,
    );
    await queryRunner.query(`DROP TYPE "public"."devices_role_enum_old"`);
    await queryRunner.query(
      `CREATE INDEX "ix_devices_zone_role" ON "devices" ("zone_id", "role")`,
    );
  }
}
