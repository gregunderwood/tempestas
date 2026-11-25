import {
  FREEZE_MARGIN_BUCKET_MINUTES,
  TIME_IN_RANGE_BUCKET_MINUTES,
  type Reading,
} from '@tempestas/domain';
import { MILLISECONDS_PER_MINUTE } from '../../shared/time';

/** A report over some zones' readings: when it was built, and whose probes it reads. */
export interface ZoneReadingsReport {
  generatedAt: string;
  zones: readonly { nodeIds: readonly string[] }[];
}

// Hours below are counted in buckets, so a refetch sooner than one bucket shows nothing new.
export const FREEZE_MARGIN_REFRESH_MILLISECONDS =
  FREEZE_MARGIN_BUCKET_MINUTES * MILLISECONDS_PER_MINUTE;

// Thirty days of readings is a heavy query on a Pi, and the hours show to a tenth: a few buckets is soon enough.
const TIME_IN_RANGE_BUCKETS_PER_REFRESH = 3;
export const TIME_IN_RANGE_REFRESH_MILLISECONDS =
  TIME_IN_RANGE_BUCKETS_PER_REFRESH *
  TIME_IN_RANGE_BUCKET_MINUTES *
  MILLISECONDS_PER_MINUTE;

/** The newest reading from the report's zones when it is a refresh interval past what the report, or the last refresh, covered. */
export function findReadingDueARefresh(
  report: ZoneReadingsReport,
  readings: readonly Reading[],
  refreshedForReadingAtMs: number,
  refreshMilliseconds: number,
): number | null {
  const newestReadingMs = findNewestReportedReadingMs(report, readings);
  if (newestReadingMs === null) return null;
  const coveredUpToMs = Math.max(
    Date.parse(report.generatedAt),
    refreshedForReadingAtMs,
  );
  const isARefreshBehind =
    newestReadingMs - coveredUpToMs >= refreshMilliseconds;
  return isARefreshBehind ? newestReadingMs : null;
}

function findNewestReportedReadingMs(
  report: ZoneReadingsReport,
  readings: readonly Reading[],
): number | null {
  const reportedNodeIds = new Set(report.zones.flatMap((zone) => zone.nodeIds));
  const reportedReadingTimes = readings
    .filter((reading) => reportedNodeIds.has(reading.nodeId))
    .map((reading) => Date.parse(reading.createdAt));
  if (reportedReadingTimes.length === 0) return null;
  return Math.max(...reportedReadingTimes);
}
