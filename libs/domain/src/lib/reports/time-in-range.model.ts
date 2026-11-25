import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';
import type { SensorSource } from '../zones/zone.model';

export const TIME_IN_RANGE_DEFAULT_DAYS = 30;
export const TIME_IN_RANGE_MAX_DAYS = 90;
/** Each probe's readings are judged against the band in stretches this long. */
export const TIME_IN_RANGE_BUCKET_MINUTES = 5;
/** A reading counts until the next one, but never for longer than this, so a gap is not read as in range. */
export const TIME_IN_RANGE_LONGEST_HELD_MINUTES = 1;

export interface TimeInRangeQuery {
  /** Daylight and night periods over this many days, the running one included. */
  days?: number;
}

export type PeriodKind = 'day' | 'night';

/** One rule's on-setpoint, read from that rule's own sensor source. */
export interface BandBound {
  role: DeviceRole;
  setpointC: number;
  sensorSource: SensorSource;
}

/** The coldest reading of a night, or the warmest of a day. */
export interface PeriodExtreme {
  temperatureC: number;
  at: string;
  nodeId: NodeId;
  sensorId: string;
}

export interface TimeInRangePeriod {
  kind: PeriodKind;
  from: string;
  to: string;
  inProgress: boolean;
  hoursBelow: number;
  hoursInRange: number;
  hoursAbove: number;
  /** The rest of the period, so a gap is never counted as in range. */
  hoursWithoutReadings: number;
  /** Lowest at night, highest by day; null when no probe in the zone reported. */
  extreme: PeriodExtreme | null;
}

export interface ZoneTimeInRange {
  zoneId: string;
  zoneSlug: string;
  zoneName: string;
  timezone: string;
  /** The nodes whose probes the report reads. */
  nodeIds: NodeId[];
  /** The heating rules' heat on-setpoints; empty when the zone has no heating rule, so nothing is below. */
  lowerBounds: BandBound[];
  /** The cooling rules' cool on-setpoints; empty when the zone has no cooling rule, so nothing is above. */
  upperBounds: BandBound[];
  /** Newest first. */
  periods: TimeInRangePeriod[];
}

export interface TimeInRangeReport {
  days: number;
  generatedAt: string;
  /** Only zones with at least one node. */
  zones: ZoneTimeInRange[];
}
