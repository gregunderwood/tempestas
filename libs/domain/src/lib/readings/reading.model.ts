import type { NodeId } from '../nodes/node.model';

/**
 * All wire timestamps are ISO-8601 strings, never `Date`.
 *
 * The old API emitted `created_at` as the naive string "%m/%d/%Y, %H:%M:%S",
 * which forced three separate `new Date(`${x} UTC`)` hacks in the Angular
 * client. Typing these as `string` makes that hack unwriteable.
 */
export type ReadingId = string;

export interface Reading {
  /** UUID. The old client typed this `number`, which was simply wrong. */
  id: ReadingId;
  nodeId: NodeId;
  sensorId: string;
  temperature: number;
  humidity: number;
  /**
   * Null when the sensor reported an invalid CO2 value. The node reports
   * validity honestly and never substitutes a last-known-good reading -
   * a dead sensor stuck on a low value would otherwise run the burner forever.
   */
  co2: number | null;
  /** ISO-8601. Server-stamped on receipt: an ESP32 has no RTC. */
  createdAt: string;
}

/**
 * Null where the window contains no usable value - an empty window has no
 * average, and CO2 has none if every reading in the window was invalid. The old
 * `Stats` type was `any`, so this arrived at the client as NaN.
 */
export interface ReadingAverages {
  temperature: number | null;
  humidity: number | null;
  co2: number | null;
}

/** min/max are whole readings so the UI can link to the record that produced them. */
export interface ReadingExtremes {
  temperature: Reading | null;
  humidity: Reading | null;
  co2: Reading | null;
}

export interface ReadingStats {
  min: ReadingExtremes;
  max: ReadingExtremes;
  average: ReadingAverages;
  /** Echoed back so the dashboard can label the window it is showing. */
  from: string;
  to: string;
}

export interface ReadingsQuery {
  days?: number;
  from?: string;
  to?: string;
  nodeId?: NodeId;
  /**
   * Rows to return, newest first. Bounded on purpose: 90 days of retention at
   * one sample per node per 10 s is over three quarters of a million rows, and
   * the dashboard asks for stats over a window rather than the window itself.
   */
  limit?: number;
}

export type StatsQuery = ReadingsQuery;
