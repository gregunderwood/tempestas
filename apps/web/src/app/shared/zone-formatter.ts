const FORMAT_LOCALE = 'en-GB';
const UTC = 'UTC';

export type InstantFormatter = (instantMs: number) => string;

// A bad zone name must not silently fall back to the browser's own zone.
export function buildZoneFormatter(
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): InstantFormatter {
  const zoneFormat = createZoneFormat(timezone, options);
  if (zoneFormat) return (instantMs) => zoneFormat.format(instantMs);
  const utcFormat = new Intl.DateTimeFormat(FORMAT_LOCALE, {
    ...options,
    timeZone: UTC,
  });
  return (instantMs) => `${utcFormat.format(instantMs)} ${UTC}`;
}

function createZoneFormat(
  timezone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat(FORMAT_LOCALE, {
      ...options,
      timeZone: timezone,
    });
  } catch {
    return null;
  }
}
