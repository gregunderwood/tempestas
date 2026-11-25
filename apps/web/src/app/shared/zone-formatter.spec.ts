import { buildZoneFormatter } from './zone-formatter';

const HOUR_MINUTE: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};
const INSTANT_MS = Date.parse('2026-11-23T12:00:00Z');

describe('buildZoneFormatter', () => {
  it("formats in the zone's own time", () => {
    expect(buildZoneFormatter('America/Regina', HOUR_MINUTE)(INSTANT_MS)).toBe(
      '06:00',
    );
  });

  it('falls back to UTC, and says so, for a zone name it does not know', () => {
    expect(buildZoneFormatter('Not/AZone', HOUR_MINUTE)(INSTANT_MS)).toBe(
      '12:00 UTC',
    );
  });
});
