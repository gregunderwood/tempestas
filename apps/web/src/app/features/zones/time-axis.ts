import { MILLISECONDS_PER_MINUTE } from '../../shared/time';
import {
  buildZoneFormatter,
  type InstantFormatter,
} from '../../shared/zone-formatter';

const TIME_LABEL_EVERY_HOURS = 6;
const TIME_LABEL_STEP_MILLISECONDS = 30 * MILLISECONDS_PER_MINUTE;
const TIME_LABEL_MARGIN_PERCENT = 10;
const FULL_PERCENT = 100;
const PERCENT_DECIMALS = 3;
const HOUR_MINUTE_FORMAT: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

export interface TimeWindow {
  fromMs: number;
  toMs: number;
}

export interface PositionedLabel {
  text: string;
  atPercent: number;
}

export type ClockFormatter = InstantFormatter;

export function buildClockFormatter(timezone: string): ClockFormatter {
  return buildZoneFormatter(timezone, HOUR_MINUTE_FORMAT);
}

// Stepping by half-hours so a zone offset by half an hour still lands on whole local hours.
export function buildTimeLabels(
  timeWindow: TimeWindow,
  formatClock: ClockFormatter,
): PositionedLabel[] {
  const labels: PositionedLabel[] = [];
  const firstStepMs =
    Math.ceil(timeWindow.fromMs / TIME_LABEL_STEP_MILLISECONDS) *
    TIME_LABEL_STEP_MILLISECONDS;
  for (
    let instantMs = firstStepMs;
    instantMs <= timeWindow.toMs;
    instantMs += TIME_LABEL_STEP_MILLISECONDS
  ) {
    const text = formatClock(instantMs);
    const atPercent = toPercent(instantMs - timeWindow.fromMs, timeWindow);
    if (isQuarterDayLabel(text) && isAwayFromEdges(atPercent)) {
      labels.push({ text, atPercent });
    }
  }
  return labels;
}

function isQuarterDayLabel(clockText: string): boolean {
  const [hours, minutes] = clockText
    .split(':')
    .map((part) => parseInt(part, 10));
  return minutes === 0 && hours % TIME_LABEL_EVERY_HOURS === 0;
}

function isAwayFromEdges(atPercent: number): boolean {
  return (
    atPercent >= TIME_LABEL_MARGIN_PERCENT &&
    atPercent <= FULL_PERCENT - TIME_LABEL_MARGIN_PERCENT
  );
}

export function toPercent(
  milliseconds: number,
  timeWindow: TimeWindow,
): number {
  const scale = 10 ** PERCENT_DECIMALS;
  return (
    Math.round(
      (milliseconds / (timeWindow.toMs - timeWindow.fromMs)) *
        FULL_PERCENT *
        scale,
    ) / scale
  );
}
