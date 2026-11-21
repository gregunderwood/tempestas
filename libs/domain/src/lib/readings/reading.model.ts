import type { MetricKey, NodeId } from '../nodes/node.model';

export type ReadingId = string;

type PerMetric<Value> = Record<MetricKey, Value>;

/** A node can carry several sensors, so a reading keyed by node alone hides all but one. */
export function sensorKey(reading: {
  nodeId: NodeId;
  sensorId: string;
}): string {
  return `${reading.nodeId}/${reading.sensorId}`;
}

export interface Reading {
  id: ReadingId;
  nodeId: NodeId;
  sensorId: string;
  temperature: number;
  /** Null when the sensor has none, e.g. a DS18B20. No rule reads it, so it never drops the reading. */
  humidity: number | null;
  /** Null when invalid, never a last-known-good: a stuck low value would run the burner forever. */
  co2: number | null;
  /** ISO-8601. Server-stamped on receipt: an ESP32 has no RTC. */
  createdAt: string;
}

/** Null where the window holds no usable value. */
export type ReadingAverages = PerMetric<number | null>;

/** Whole readings, so the UI can link to the record that produced them. */
export type ReadingExtremes = PerMetric<Reading | null>;

export interface ReadingStats {
  min: ReadingExtremes;
  max: ReadingExtremes;
  average: ReadingAverages;
  from: string;
  to: string;
}

export interface SegmentStats {
  kind: 'day' | 'night';
  from: string;
  to: string;
  /** True for the period still running, whose `to` is now. */
  inProgress: boolean;
  stats: ReadingStats;
}

/** Deliberately no combined 24-hour figure: the burner does a different job by day and by night. */
export interface DayNightStats {
  /** Oldest first. The last entry is the period still running. */
  periods: SegmentStats[];
  /** When the running period ends, so a client can refresh without its own boundary logic. */
  nextBoundary: string | null;
  daylight: {
    /** Local wall-clock, inclusive. */
    startTime: string;
    /** Local wall-clock, exclusive. */
    endTime: string;
    timezone: string;
  };
}

export enum ReadingOrder {
  NewestFirst = 'newest-first',
  OldestFirst = 'oldest-first',
}

export interface ReadingsQuery {
  days?: number;
  from?: string;
  to?: string;
  nodeId?: NodeId;
  /** Only with `nodeId`: a sensor id is unique on its node, not across nodes. */
  sensorId?: string;
  order?: ReadingOrder;
  /** Bounded on purpose: retention holds far more rows than any screen should fetch. */
  limit?: number;
}

export type StatsQuery = ReadingsQuery;
