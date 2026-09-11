import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give the CO2 generator a dead band, as every other role already had.
 *
 * A single `co2ThresholdPpm` chatters. Measured in the greenhouse with a real
 * burner: it cut at 1509 ppm and the rule wanted it back on at 1494 - a 15 ppm
 * band, so each cycle would have been an ignition for a few seconds of burn,
 * spaced only by the device's minimum-off time. Ignition cycling is the main
 * wear mechanism on a propane appliance, and the gas spent lighting it dwarfs
 * the gas burned.
 *
 * 1400/1500 comes from the observed rates, not a guess: roughly +15-20 ppm/min
 * with the burner running at that concentration and -28 ppm/min of leakage
 * without it, so the band takes about six minutes to climb and three and a half
 * to fall.
 *
 * The `down` restores a single threshold at the OFF setpoint, which is the
 * conservative direction - it reverts to cutting out at the same concentration
 * rather than to burning longer.
 */
export class AddCo2DeadBand1789087500000 implements MigrationInterface {
  name = 'AddCo2DeadBand1789087500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE zones SET rules_config = jsonb_set(
        jsonb_set(
          rules_config #- '{thresholds,co2ThresholdPpm}',
          '{thresholds,co2OffPpm}',
          COALESCE(rules_config #> '{thresholds,co2ThresholdPpm}', '1500'::jsonb)
        ),
        '{thresholds,co2OnPpm}',
        '1400'::jsonb
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE zones SET rules_config = jsonb_set(
        rules_config #- '{thresholds,co2OnPpm}' #- '{thresholds,co2OffPpm}',
        '{thresholds,co2ThresholdPpm}',
        COALESCE(rules_config #> '{thresholds,co2OffPpm}', '1500'::jsonb)
      )
    `);
  }
}
