import {
  FREEZE_MARGIN_ALARM_C,
  FREEZE_MARGIN_BUCKET_MINUTES,
  type FreezeConcern,
  type FreezeMarginNight,
  type HeatingAtColdest,
  type RelayState,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import {
  buildZoneFormatter,
  type InstantFormatter,
} from '../../shared/zone-formatter';
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

type OwedHeatConcern = Exclude<FreezeConcern, 'cold-despite-heat'>;

interface OwedHeatWording {
  state: RelayState;
  describe(device: HeatingAtColdest): string;
}

const OWED_HEAT_WORDING: Record<OwedHeatConcern, OwedHeatWording> = {
  'heat-off-while-cold': {
    state: 'off',
    describe: (device) =>
      `${device.deviceName} was off at the coldest moment, ${describeSetpoint(device)}.`,
  },
  'heat-unknown-while-cold': {
    state: 'unknown',
    describe: (device) =>
      `Nothing was heard from ${device.deviceName} at the coldest moment, ${describeSetpoint(device)}.`,
  },
};
const COLD_DESPITE_HEAT_WORDING = `The heat was on and it still came within ${FREEZE_MARGIN_ALARM_C} °C of freezing.`;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const BUCKET_HOURS = FREEZE_MARGIN_BUCKET_MINUTES / 60;
const NIGHT_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
};

export function buildNightRows(zone: ZoneFreezeMargin): NightRow[] {
  const formatDate = buildZoneFormatter(zone.timezone, NIGHT_DATE_FORMAT);
  const formatClock = buildClockFormatter(zone.timezone);
  return zone.nights.map((night) => ({
    from: night.from,
    label: labelNight(night, formatDate),
    coldest: describeColdest(night, formatClock),
    heating: describeHeating(night.heating),
    hoursBelow: describeHoursBelow(night),
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
  if (night.concern === null) return null;
  if (night.concern === 'cold-despite-heat') return COLD_DESPITE_HEAT_WORDING;
  const wording = OWED_HEAT_WORDING[night.concern];
  return night.heating
    .filter((device) => device.isHeatOwed && device.state === wording.state)
    .map((device) => wording.describe(device))
    .join(' ');
}

function describeSetpoint(device: HeatingAtColdest): string {
  return device.isOnBelowFromRule
    ? `below its ${device.onBelowC} °C on-setpoint`
    : `below the default ${device.onBelowC} °C warning, with no heat on-setpoint of its own`;
}

function describeHoursBelow(night: FreezeMarginNight): string {
  if (night.coldest === null) return '—';
  const hoursBelow = formatHours(night.hoursBelowWarning);
  if (!isMissingReadings(night)) return hoursBelow;
  return `${hoursBelow} of ${formatHours(night.hoursWithReadings)} read`;
}

// Night edges rarely fall on a bucket boundary, so a full night can come up one bucket short.
function isMissingReadings(night: FreezeMarginNight): boolean {
  const nightHours =
    (new Date(night.to).getTime() - new Date(night.from).getTime()) /
    MILLISECONDS_PER_HOUR;
  return night.hoursWithReadings < nightHours - BUCKET_HOURS;
}

function labelNight(
  night: FreezeMarginNight,
  formatDate: InstantFormatter,
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
