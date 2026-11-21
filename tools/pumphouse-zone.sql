-- The pumphouse zone. Re-run to change a setpoint; how and why are in docs/Pumphouse.md.
-- An invalid rule refuses the zone rather than running, so check GET /api/health `problems` after.

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
