import type {
  BandBound,
  PeriodKind,
  TimeInRangePeriod,
  ZoneTimeInRange,
} from '@tempestas/domain';
import { MILLISECONDS_PER_MINUTE, MINUTES_PER_HOUR } from '../../shared/time';
import {
  buildZoneFormatter,
  type InstantFormatter,
} from '../../shared/zone-formatter';
import { buildClockFormatter, type ClockFormatter } from '../zones/time-axis';
import { describeSensorSource, labelRole } from '../zones/zone-words';
import { formatHours } from './runtime-trend';

export interface PeriodRow {
  from: string;
  label: string;
  extreme: string;
  below: string;
  inRange: string;
  above: string;
  withoutReadings: string;
}

interface PeriodWording {
  name: string;
  running: string;
  extreme: string;
  plural: string;
}

const PERIOD_WORDING: Record<PeriodKind, PeriodWording> = {
  day: { name: 'day', running: 'today', extreme: 'High', plural: 'Days' },
  night: {
    name: 'night',
    running: 'tonight',
    extreme: 'Low',
    plural: 'Nights',
  },
};
const PERIOD_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
};
const MILLISECONDS_PER_HOUR = MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;
const PERCENT = 100;
const EMPTY_CELL = '—';
const SUMMARY_KINDS: readonly PeriodKind[] = ['night', 'day'];

interface ShareOfReadHours {
  label: string;
  readHours(period: TimeInRangePeriod): number;
  isShown(zone: ZoneTimeInRange): boolean;
}

const SHARES_OF_READ_HOURS: readonly ShareOfReadHours[] = [
  {
    label: 'in range',
    readHours: (period) => period.hoursInRange,
    isShown: () => true,
  },
  {
    label: 'below',
    readHours: (period) => period.hoursBelow,
    isShown: hasLowerBound,
  },
  {
    label: 'above',
    readHours: (period) => period.hoursAbove,
    isShown: hasUpperBound,
  },
];

export function buildPeriodRows(zone: ZoneTimeInRange): PeriodRow[] {
  const formatDate = buildZoneFormatter(zone.timezone, PERIOD_DATE_FORMAT);
  const formatClock = buildClockFormatter(zone.timezone);
  return zone.periods.map((period) => ({
    from: period.from,
    label: labelPeriod(period, formatDate),
    extreme: describeExtreme(period, formatClock),
    below: formatHours(period.hoursBelow),
    inRange: formatHours(period.hoursInRange),
    above: formatHours(period.hoursAbove),
    withoutReadings: formatPercent(
      period.hoursWithoutReadings / measurePeriodHours(period),
    ),
  }));
}

export function describeLowerBound(zone: ZoneTimeInRange): string {
  if (!hasLowerBound(zone)) {
    return 'No lower bound: no heater or heat tape rule here.';
  }
  return `Below: under ${zone.lowerBounds.map(describeBound).join(', or ')}.`;
}

export function describeUpperBound(zone: ZoneTimeInRange): string {
  if (!hasUpperBound(zone)) {
    return 'No upper bound: no exhaust fan rule here.';
  }
  return `Above: over ${zone.upperBounds.map(describeBound).join(', or ')}.`;
}

/** One line per kind of period, never both together: day and night are different jobs. */
export function summariseShareInRange(zone: ZoneTimeInRange): string[] {
  return SUMMARY_KINDS.flatMap((kind) => {
    const periods = zone.periods.filter((period) => period.kind === kind);
    const readHours = sumHours(periods, countReadHours);
    if (readHours === 0) return [];
    const shares = SHARES_OF_READ_HOURS.filter((share) =>
      share.isShown(zone),
    ).map(
      (share) =>
        `${formatPercent(sumHours(periods, share.readHours) / readHours)} ${share.label}`,
    );
    return [`${PERIOD_WORDING[kind].plural}: ${shares.join(', ')}`];
  });
}

export function hasLowerBound(zone: ZoneTimeInRange): boolean {
  return zone.lowerBounds.length > 0;
}

export function hasUpperBound(zone: ZoneTimeInRange): boolean {
  return zone.upperBounds.length > 0;
}

function describeBound(bound: BandBound): string {
  return `the ${labelRole(bound.role).toLowerCase()}'s ${bound.setpointC} °C on-setpoint, read from ${describeSensorSource(bound.sensorSource)}`;
}

function labelPeriod(
  period: TimeInRangePeriod,
  formatDate: InstantFormatter,
): string {
  const wording = PERIOD_WORDING[period.kind];
  const date = formatDate(Date.parse(period.from));
  const label = `${date}, ${wording.name}`;
  return period.inProgress ? `${label} (${wording.running})` : label;
}

function describeExtreme(
  period: TimeInRangePeriod,
  formatClock: ClockFormatter,
): string {
  if (period.extreme === null) return 'No readings';
  const { temperatureC, at } = period.extreme;
  return `${PERIOD_WORDING[period.kind].extreme} ${temperatureC.toFixed(1)} °C at ${formatClock(Date.parse(at))}`;
}

function measurePeriodHours(period: TimeInRangePeriod): number {
  return (
    (Date.parse(period.to) - Date.parse(period.from)) / MILLISECONDS_PER_HOUR
  );
}

function countReadHours(period: TimeInRangePeriod): number {
  return period.hoursBelow + period.hoursInRange + period.hoursAbove;
}

function sumHours(
  periods: readonly TimeInRangePeriod[],
  readHours: (period: TimeInRangePeriod) => number,
): number {
  return periods.reduce((total, period) => total + readHours(period), 0);
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return EMPTY_CELL;
  return `${Math.round(fraction * PERCENT)}%`;
}
