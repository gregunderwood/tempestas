import {
  FREEZE_MARGIN_ALARM_C,
  type ColdestReading,
  type FreezeConcern,
  type FreezeMarginNight,
  type HeatingAtColdest,
  type RelayState,
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
type OwedHeatConcern = Exclude<FreezeConcern, 'cold-despite-heat'>;

interface OwedHeatWording {
  state: RelayState;
  describe(device: HeatingAtColdest): string;
}

const OWED_HEAT_WORDING: Record<OwedHeatConcern, OwedHeatWording> = {
  'heat-off-while-cold': {
    state: 'off',
    describe: (device) =>
      `${device.deviceName} was off at the coldest moment, below its ${device.onBelowC} °C on-setpoint.`,
  },
  'heat-unknown-while-cold': {
    state: 'unknown',
    describe: (device) =>
      `Nothing was heard from ${device.deviceName} at the coldest moment, below its ${device.onBelowC} °C on-setpoint.`,
  },
};
const COLD_DESPITE_HEAT_WORDING = `The heat was on and it still came within ${FREEZE_MARGIN_ALARM_C} °C of freezing.`;
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
    concern: describeConcern(night),
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

function describeConcern(night: FreezeMarginNight): string | null {
  if (night.concern === null || night.coldest === null) return null;
  if (night.concern === 'cold-despite-heat') return COLD_DESPITE_HEAT_WORDING;
  const wording = OWED_HEAT_WORDING[night.concern];
  return listOwedHeat(night.heating, night.coldest)
    .filter((device) => device.state === wording.state)
    .map((device) => wording.describe(device))
    .join(' ');
}

function listOwedHeat(
  heating: readonly HeatingAtColdest[],
  coldest: ColdestReading,
): HeatingAtColdest[] {
  return heating.filter((device) => coldest.temperatureC < device.onBelowC);
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
