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

export interface ReadingAverages {
  temperature: number;
  humidity: number;
  co2: number | null;
}

/** min/max are whole readings so the UI can link to the record that produced them. */
export interface ReadingExtremes {
  temperature: Reading;
  humidity: Reading;
  co2: Reading;
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
}

export type StatsQuery = ReadingsQuery;
