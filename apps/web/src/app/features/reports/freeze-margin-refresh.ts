import {
  FREEZE_MARGIN_BUCKET_MINUTES,
  type FreezeMarginReport,
  type Reading,
} from '@tempestas/domain';
import { MILLISECONDS_PER_MINUTE } from '../../shared/time';

// Hours below are counted in buckets, so a refetch sooner than one bucket shows nothing new.
export const FREEZE_MARGIN_REFRESH_MILLISECONDS =
  FREEZE_MARGIN_BUCKET_MINUTES * MILLISECONDS_PER_MINUTE;

/** The newest heated-zone reading when it is a bucket past what the report, or the last refresh, covered. */
export function findReadingDueARefresh(
  report: FreezeMarginReport,
  readings: readonly Reading[],
  refreshedForReadingAtMs: number,
): number | null {
  const newestReadingMs = findNewestHeatedReadingMs(report, readings);
  if (newestReadingMs === null) return null;
  const coveredUpToMs = Math.max(
    Date.parse(report.generatedAt),
    refreshedForReadingAtMs,
  );
  const isABucketBehind =
    newestReadingMs - coveredUpToMs >= FREEZE_MARGIN_REFRESH_MILLISECONDS;
  return isABucketBehind ? newestReadingMs : null;
}

function findNewestHeatedReadingMs(
  report: FreezeMarginReport,
  readings: readonly Reading[],
): number | null {
  const heatedNodeIds = new Set(report.zones.flatMap((zone) => zone.nodeIds));
  const heatedReadingTimes = readings
    .filter((reading) => heatedNodeIds.has(reading.nodeId))
    .map((reading) => Date.parse(reading.createdAt));
  if (heatedReadingTimes.length === 0) return null;
  return Math.max(...heatedReadingTimes);
}
