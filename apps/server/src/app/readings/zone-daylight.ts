import type { ConfigService } from '@nestjs/config';
import type { DayNightStats } from '@tempestas/domain';
import { parseZoneRulesConfig } from '../rules/rules-config';

export type Daylight = DayNightStats['daylight'];

export const DEFAULT_TIMEZONE = 'America/Vancouver';
const DEFAULT_TIMEZONE_SETTING = 'TEMPESTAS_TZ';
const DEFAULT_DAYLIGHT_START = '06:30';
const DEFAULT_DAYLIGHT_END = '18:30';

// History, not control: a zone with no window, or rules that do not parse, still has nights.
export function resolveZoneDaylight(
  rulesConfig: unknown,
  fallbackTimezone: string,
): Daylight {
  const fallback: Daylight = {
    startTime: DEFAULT_DAYLIGHT_START,
    endTime: DEFAULT_DAYLIGHT_END,
    timezone: fallbackTimezone,
  };
  if (!rulesConfig) return fallback;
  const parsed = parseZoneRulesConfig(rulesConfig);
  if (parsed.ok === false) return fallback;
  const { daylight, timezone } = parsed.config;
  if (!daylight) return { ...fallback, timezone };
  return { startTime: daylight.start, endTime: daylight.end, timezone };
}

// Never the host locale: that was the old DST bug.
export function resolveDefaultTimezone(config: ConfigService): string {
  return config.get<string>(DEFAULT_TIMEZONE_SETTING, DEFAULT_TIMEZONE);
}
