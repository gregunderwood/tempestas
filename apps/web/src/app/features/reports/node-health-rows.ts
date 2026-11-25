import type {
  AgentVersionChange,
  NodeHealth,
  ReadingGap,
} from '@tempestas/domain';
import {
  buildZoneFormatter,
  type InstantFormatter,
} from '../../shared/zone-formatter';
import {
  MILLISECONDS_PER_MINUTE,
  MINUTES_PER_DAY,
  SECONDS_PER_MINUTE,
} from '../../shared/time';
import { formatDuration } from '../zones/zone-words';

export type HealthEventKind = 'gap' | 'reboot' | 'update';

export interface HealthEventRow {
  at: string;
  kind: HealthEventKind;
  when: string;
  what: string;
  length: string;
}

const EVENT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};
const FIRST_READING_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
};
const NO_LENGTH = '—';
const MILLISECONDS_PER_DAY = MINUTES_PER_DAY * MILLISECONDS_PER_MINUTE;

/** Gaps, reboots and updates in one list, newest first. */
export function buildHealthEventRows(node: NodeHealth): HealthEventRow[] {
  const formatWhen = buildZoneFormatter(node.timezone, EVENT_TIME_FORMAT);
  const rows = [
    ...node.gaps.map((gap) => describeGap(gap, formatWhen)),
    ...node.reboots.map((reboot) => ({
      at: reboot.at,
      kind: 'reboot' as const,
      when: formatWhen(Date.parse(reboot.at)),
      what: 'Rebooted',
      length: NO_LENGTH,
    })),
    ...node.versionChanges.map((change) =>
      describeVersionChange(change, formatWhen),
    ),
  ];
  return rows.sort((first, second) => second.at.localeCompare(first.at));
}

export function describeEventCounts(node: NodeHealth, days: number): string {
  const counts = [
    ...(node.hasSensors
      ? [
          countOf(node.gaps.length, 'gap', 'gaps'),
          countOf(node.reboots.length, 'reboot', 'reboots'),
        ]
      : []),
    countOf(node.versionChanges.length, 'agent update', 'agent updates'),
  ];
  return capitalise(`${counts.join(', ')} in the last ${days} days.`);
}

/** Total time without readings, or null when there was none. */
export function describeTimeWithoutReadings(node: NodeHealth): string | null {
  const totalMinutes = node.gaps.reduce((total, gap) => total + gap.minutes, 0);
  if (totalMinutes === 0) return null;
  return `${formatDuration(totalMinutes * SECONDS_PER_MINUTE)} without readings`;
}

/** Why the readings cover less than the whole period, or null when they cover it. */
export function describeReadingCoverage(
  node: NodeHealth,
  report: { days: number; generatedAt: string },
): string | null {
  if (!node.hasSensors) {
    return 'No sensors, so no readings to find gaps or reboots in.';
  }
  if (node.firstReadingAt === null) {
    return `No readings in the last ${report.days} days.`;
  }
  const periodStartMs =
    Date.parse(report.generatedAt) - report.days * MILLISECONDS_PER_DAY;
  const isLateStart =
    Date.parse(node.firstReadingAt) - periodStartMs > MILLISECONDS_PER_DAY;
  if (!isLateStart) return null;
  const formatDate = buildZoneFormatter(node.timezone, FIRST_READING_FORMAT);
  return `Readings start ${formatDate(Date.parse(node.firstReadingAt))}.`;
}

function describeGap(
  gap: ReadingGap,
  formatWhen: InstantFormatter,
): HealthEventRow {
  return {
    at: gap.from,
    kind: 'gap',
    when: formatWhen(Date.parse(gap.from)),
    what: gap.isOngoing ? 'No readings since, still silent' : 'No readings',
    length: formatDuration(gap.minutes * SECONDS_PER_MINUTE),
  };
}

function describeVersionChange(
  change: AgentVersionChange,
  formatWhen: InstantFormatter,
): HealthEventRow {
  const fromVersion = change.fromVersion ?? 'unknown';
  const verb = change.isRollBack ? 'Rolled back' : 'Updated';
  return {
    at: change.at,
    kind: 'update',
    when: formatWhen(Date.parse(change.at)),
    what: `${verb} agent ${fromVersion} → ${change.toVersion}`,
    length: NO_LENGTH,
  };
}

function countOf(count: number, singular: string, plural: string): string {
  if (count === 0) return `no ${plural}`;
  return `${count} ${count === 1 ? singular : plural}`;
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
