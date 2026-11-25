import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_TIMEZONE,
  resolveDefaultTimezone,
  resolveZoneDaylight,
} from './zone-daylight';

const FALLBACK_TIMEZONE = 'America/Toronto';
const VALID_RULES = {
  enabledRoles: [],
  sensorPolicy: { default: { source: 'min' } },
  rules: {},
  timezone: 'America/Edmonton',
};

describe('resolveZoneDaylight', () => {
  it('reads the zone window and timezone', () => {
    expect(
      resolveZoneDaylight(
        { ...VALID_RULES, daylight: { start: '07:00', end: '19:00' } },
        FALLBACK_TIMEZONE,
      ),
    ).toEqual({
      startTime: '07:00',
      endTime: '19:00',
      timezone: 'America/Edmonton',
    });
  });

  it('keeps the zone timezone with the default window when the zone has none', () => {
    expect(resolveZoneDaylight(VALID_RULES, FALLBACK_TIMEZONE)).toEqual({
      startTime: '06:30',
      endTime: '18:30',
      timezone: 'America/Edmonton',
    });
  });

  it.each([null, undefined, { timezone: 'America/Edmonton' }])(
    'falls back to the deployment default for %j',
    (rulesConfig) => {
      expect(resolveZoneDaylight(rulesConfig, FALLBACK_TIMEZONE)).toEqual({
        startTime: '06:30',
        endTime: '18:30',
        timezone: FALLBACK_TIMEZONE,
      });
    },
  );
});

describe('resolveDefaultTimezone', () => {
  it('reads TEMPESTAS_TZ, or the default without it', () => {
    expect(
      resolveDefaultTimezone(
        new ConfigService({ TEMPESTAS_TZ: 'America/Edmonton' }),
      ),
    ).toBe('America/Edmonton');
    expect(resolveDefaultTimezone(new ConfigService({}))).toBe(
      DEFAULT_TIMEZONE,
    );
  });
});
