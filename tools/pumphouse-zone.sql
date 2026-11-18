-- The pumphouse zone. Run on elantris:
--
--   sudo -u postgres psql -d tempestas -v ON_ERROR_STOP=1 -f tools/pumphouse-zone.sql
--
-- Data for one installation, so a script rather than a migration: every dev
-- database runs migrations, and none of them has a pumphouse.
--
-- Idempotent: re-running it resets the rules to what is written here, which is
-- how a setpoint is changed. There is no zones API on purpose - this is policy
-- that drives a heater, and it is changed by review, not by a form.
--
-- The server validates it on its next evaluation. A typo here does not become a
-- heater rule: the zone is refused, logged at ERROR, and named in
-- GET /api/health `problems`. Check that after running this.
--
-- Why each number is what it is: docs/Pumphouse.md.

INSERT INTO zones (slug, display_name, rules_config)
VALUES (
  'pumphouse',
  'Pumphouse',
  $${
    "enabledRoles": ["heater", "heat_tape"],
    "sensorPolicy": { "default": { "source": "min", "maxAgeMs": 120000 } },
    "rules": {
      "heat_tape": {
        "kind": "thermostat", "mode": "heat",
        "onAtC": 4, "offAtC": 6,
        "onStale": "on"
      },
      "heater": {
        "kind": "thermostat", "mode": "heat",
        "onAtC": 2, "offAtC": 5,
        "onStale": "on"
      }
    },
    "timezone": "America/Vancouver"
  }$$::jsonb
)
ON CONFLICT (slug) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      rules_config = EXCLUDED.rules_config,
      updated_at   = now();

SELECT slug, rules_config FROM zones WHERE slug = 'pumphouse';
