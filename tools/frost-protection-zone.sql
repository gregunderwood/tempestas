-- A frost-protected zone: heater and heat tape that fail on. Run it as
--   psql -v ON_ERROR_STOP=1 -v slug=pumphouse -v display_name=Pumphouse -f tools/frost-protection-zone.sql
-- Re-run to change a setpoint; why is in docs/Pumphouse.md and docs/Crawlspace.md.
-- An invalid rule refuses the zone rather than running, so check GET /api/health `problems` after.

SELECT :{?slug} AND :{?display_name} AS has_zone_variables \gset
\if :has_zone_variables
\else
  DO $$ BEGIN RAISE EXCEPTION 'name the zone: psql -v slug=... -v display_name=...'; END $$;
\endif

INSERT INTO zones (slug, display_name, rules_config)
VALUES (
  :'slug',
  :'display_name',
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

SELECT slug, display_name, rules_config FROM zones WHERE slug = :'slug';
