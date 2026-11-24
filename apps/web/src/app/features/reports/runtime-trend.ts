import type { DeviceRuntimeDay } from '@tempestas/domain';

export const TREND_HEIGHT = 60;
export const TREND_BAR_PITCH = 10;
const TREND_BAR_WIDTH = 8;
const HOURS_PER_DAY = 24;

export interface TrendBar {
  date: string;
  x: number;
  width: number;
  onY: number;
  onHeight: number;
  unknownY: number;
  unknownHeight: number;
  hasRunCappedAtLastSeen: boolean;
  description: string;
}

// Scaled to a whole day, so a quiet month does not look as busy as a busy one; a 25-hour DST day still fits.
export function buildTrendBars(days: readonly DeviceRuntimeDay[]): TrendBar[] {
  const fullScaleHours = Math.max(
    HOURS_PER_DAY,
    ...days.map((day) => day.hoursOn + day.hoursUnknown),
  );
  const toHeight = (hours: number): number =>
    (hours / fullScaleHours) * TREND_HEIGHT;
  return days.map((day, index) => {
    const onHeight = toHeight(day.hoursOn);
    const unknownHeight = toHeight(day.hoursUnknown);
    return {
      date: day.date,
      x: index * TREND_BAR_PITCH,
      width: TREND_BAR_WIDTH,
      onY: TREND_HEIGHT - onHeight,
      onHeight,
      unknownY: TREND_HEIGHT - onHeight - unknownHeight,
      unknownHeight,
      hasRunCappedAtLastSeen: day.hasRunCappedAtLastSeen,
      description: describeDay(day),
    };
  });
}

export function describeDay(day: DeviceRuntimeDay): string {
  const parts = [
    `${day.date}: ${formatHours(day.hoursOn)} on`,
    `${day.starts} ${day.starts === 1 ? 'start' : 'starts'}`,
  ];
  if (day.shortestRunMinutes !== null) {
    parts.push(`shortest run ${formatMinutes(day.shortestRunMinutes)}`);
  }
  if (day.hoursUnknown > 0) {
    parts.push(`${formatHours(day.hoursUnknown)} unknown`);
  }
  if (day.hasRunCappedAtLastSeen) {
    parts.push('a run cut at the node going offline');
  }
  return parts.join(', ');
}

export function findShortestRunMinutes(
  days: readonly DeviceRuntimeDay[],
): number | null {
  const measured = days
    .map((day) => day.shortestRunMinutes)
    .filter((minutes): minutes is number => minutes !== null);
  return measured.length === 0 ? null : Math.min(...measured);
}

export function countDaysWithCappedRun(
  days: readonly DeviceRuntimeDay[],
): number {
  return days.filter((day) => day.hasRunCappedAtLastSeen).length;
}

export function formatHours(hours: number): string {
  return `${hours.toFixed(1)} h`;
}

export function formatMinutes(minutes: number): string {
  return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
}
