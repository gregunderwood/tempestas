/**
 * Replace the greenhouse-shaped `thresholds` with a rule per role.
 *
 * Every zone used to carry one flat set of greenhouse numbers - lights, burner,
 * fan, a day window - whatever it actually controlled. The pumphouse has a
 * heater and heat tape and none of those. Now each role names a kind from a
 * fixed menu and carries only that kind's numbers; the day window moves up to
 * the zone, where lights and burner share it.
 *
 * Number for number: this changes the shape and nothing the greenhouse does.
 * Every role gets `onStale: 'hold'`, which is exactly the old behaviour.
 *
 * The conversion itself is in ./rule-kinds-conversion, declared there in its
 * own frozen types rather than imported from the domain library.
 *
 * `down` refuses a zone it cannot express in the old shape - a pumphouse has no
 * lights setpoint to restore - rather than inventing greenhouse numbers for it.
 */

import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  toLegacy,
  toRuleKinds,
  type KindConfig,
  type LegacyConfig,
} from './rule-kinds-conversion';

export class RuleKindsPerRole1794975900000 implements MigrationInterface {
  name = 'RuleKindsPerRole1794975900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const zones: { id: string; rules_config: LegacyConfig | KindConfig }[] =
      await queryRunner.query(`SELECT id, rules_config FROM zones`);

    for (const zone of zones) {
      // Already converted - a zone created after this shipped - is left alone.
      if (!('thresholds' in zone.rules_config)) continue;
      await queryRunner.query(
        `UPDATE zones SET rules_config = $1 WHERE id = $2`,
        [JSON.stringify(toRuleKinds(zone.rules_config)), zone.id],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const zones: {
      id: string;
      slug: string;
      rules_config: LegacyConfig | KindConfig;
    }[] = await queryRunner.query(`SELECT id, slug, rules_config FROM zones`);

    for (const zone of zones) {
      if (!('rules' in zone.rules_config)) continue;
      const legacy = toLegacy(zone.rules_config);
      if (!legacy) {
        throw new Error(
          `Zone "${zone.slug}" has rules the old shape cannot express; ` +
            `remove or convert it by hand before reverting this migration`,
        );
      }
      await queryRunner.query(
        `UPDATE zones SET rules_config = $1 WHERE id = $2`,
        [JSON.stringify(legacy), zone.id],
      );
    }
  }
}
