import {
  FREEZE_MARGIN_ALARM_C,
  type FreezeConcern,
  type FreezeMarginNight,
  type HeatingAtColdest,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import { buildClockFormatter, type ClockFormatter } from '../zones/time-axis';
import { formatHours } from './runtime-trend';

export interface NightRow {
  from: string;
  label: string;
  coldest: string;
  heating: string;
  hoursBelow: string;
  concern: string | null;
}

type DateFormatter = (instantMs: number) => string;

const CONCERN_DESCRIPTIONS: Record<FreezeConcern, string> = {
  'heat-off-while-cold':
    'Heat was off at the coldest moment, below its on-setpoint.',
  'heat-unknown-while-cold':
    'Below the on-setpoint, and nothing was heard from the heat at the coldest moment.',
  'cold-despite-heat': `The heat was on and it still came within ${FREEZE_MARGIN_ALARM_C} °C of freezing.`,
};
const NIGHT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
};

export function buildNightRows(zone: ZoneFreezeMargin): NightRow[] {
  const formatDate = buildDateFormatter(zone.timezone);
  const formatClock = buildClockFormatter(zone.timezone);
  return zone.nights.map((night) => ({
    from: night.from,
    label: labelNight(night, formatDate),
    coldest: describeColdest(night, formatClock),
    heating: describeHeating(night.heating),
    hoursBelow:
      night.coldest === null ? '—' : formatHours(night.hoursBelowWarning),
    concern:
      night.concern === null ? null : CONCERN_DESCRIPTIONS[night.concern],
  }));
}

export function countNightsOfConcern(zone: ZoneFreezeMargin): number {
  return zone.nights.filter((night) => night.concern !== null).length;
}

export function describeWarning(zone: ZoneFreezeMargin): string {
  const warning = `Warning below ${zone.warningBelowC} °C`;
  return zone.isWarningFromRules
    ? `${warning}, the highest heat on-setpoint in its rules`
    : `${warning}, a default: no heating rule here sets one`;
}

function labelNight(
  night: FreezeMarginNight,
  formatDate: DateFormatter,
): string {
  const date = formatDate(new Date(night.from).getTime());
  return night.inProgress ? `${date} (tonight)` : date;
}

function describeColdest(
  night: FreezeMarginNight,
  formatClock: ClockFormatter,
): string {
  if (night.coldest === null) return 'No readings';
  const { temperatureC, at } = night.coldest;
  return `${temperatureC.toFixed(1)} °C at ${formatClock(new Date(at).getTime())}`;
}

function describeHeating(heating: readonly HeatingAtColdest[]): string {
  if (heating.length === 0) return '—';
  return heating
    .map((device) => `${device.deviceName} ${device.state}`)
    .join(', ');
}

// A bad zone name must not silently fall back to the browser's own zone.
function buildDateFormatter(timezone: string): DateFormatter {
  try {
    const zoneFormat = new Intl.DateTimeFormat('en-GB', {
      ...NIGHT_DATE_FORMAT,
      timeZone: timezone,
    });
    return (instantMs) => zoneFormat.format(instantMs);
  } catch {
    const utcFormat = new Intl.DateTimeFormat('en-GB', {
      ...NIGHT_DATE_FORMAT,
      timeZone: 'UTC',
    });
    return (instantMs) => `${utcFormat.format(instantMs)} UTC`;
  }
}
