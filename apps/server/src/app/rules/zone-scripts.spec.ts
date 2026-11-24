import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parseZoneRulesConfig } from './rules-config';

const TOOLS_DIRECTORY = resolve(__dirname, '../../../../../tools');
const ZONE_SCRIPT_SUFFIX = '-zone.sql';
const DOLLAR_QUOTED_JSON = /\$\$(?<json>\{[\s\S]*?\})\$\$::jsonb/;

function listZoneScripts(): string[] {
  return readdirSync(TOOLS_DIRECTORY).filter((fileName) =>
    fileName.endsWith(ZONE_SCRIPT_SUFFIX),
  );
}

function readRulesConfig(fileName: string): unknown {
  const script = readFileSync(join(TOOLS_DIRECTORY, fileName), 'utf8');
  const json = DOLLAR_QUOTED_JSON.exec(script)?.groups?.['json'];
  if (json === undefined) {
    throw new Error(`${fileName} has no $$...$$::jsonb rules_config`);
  }
  return JSON.parse(json);
}

describe('zone scripts in tools/', () => {
  it('finds the zone scripts', () => {
    expect(listZoneScripts()).toEqual(
      expect.arrayContaining(['frost-protection-zone.sql']),
    );
  });

  it.each(listZoneScripts())(
    '%s names its zone from psql variables, so one script serves every zone',
    (fileName) => {
      const script = readFileSync(join(TOOLS_DIRECTORY, fileName), 'utf8');
      expect(script).toContain(":'slug'");
      expect(script).toContain(":'display_name'");
    },
  );

  it.each(listZoneScripts())(
    '%s holds rules the server accepts',
    (fileName) => {
      expect(parseZoneRulesConfig(readRulesConfig(fileName))).toMatchObject({
        ok: true,
      });
    },
  );
});
