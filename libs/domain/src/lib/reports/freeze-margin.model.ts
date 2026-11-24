import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';
import type { RelayState } from '../zones/zone-history.model';

export const FREEZE_MARGIN_DEFAULT_NIGHTS = 30;
export const FREEZE_MARGIN_MAX_NIGHTS = 90;
/** Hours below the warning are counted in stretches this long. */
export const FREEZE_MARGIN_BUCKET_MINUTES = 10;
/** Within this many degrees of freezing with every called-for heat source on, the heat is not keeping up. */
export const FREEZE_MARGIN_ALARM_C = 1;

export interface FreezeMarginQuery {
  /** Nights in each zone, tonight included while it is running. */
  nights?: number;
}

/** Unknown is not off, so a heater nobody heard from is a concern of its own. */
export type FreezeConcern =
  'heat-off-while-cold' | 'heat-unknown-while-cold' | 'cold-despite-heat';

export interface ColdestReading {
  temperatureC: number;
  at: string;
  nodeId: NodeId;
  sensorId: string;
}

export interface HeatingAtColdest {
  deviceId: string;
  deviceName: string;
  role: DeviceRole;
  state: RelayState;
  /** Its rule's heat on-setpoint, or the default warning temperature when the rule has none. */
  onBelowC: number;
}

export interface FreezeMarginNight {
  from: string;
  to: string;
  inProgress: boolean;
  /** Null when no probe in the zone reported that night. */
  coldest: ColdestReading | null;
  /** Empty when there is no coldest reading to place them at. */
  heating: HeatingAtColdest[];
  hoursBelowWarning: number;
  /** How much of the night had readings at all, so a gap is not read as hours above the warning. */
  hoursWithReadings: number;
  concern: FreezeConcern | null;
}

export interface ZoneFreezeMargin {
  zoneId: string;
  zoneSlug: string;
  zoneName: string;
  timezone: string;
  warningBelowC: number;
  /** False when no heating rule in the zone has a heat on-setpoint, so the default was used. */
  isWarningFromRules: boolean;
  /** Newest first. */
  nights: FreezeMarginNight[];
}

export interface FreezeMarginReport {
  nights: number;
  generatedAt: string;
  marginAlarmC: number;
  /** Only zones with a heater or heat tape. */
  zones: ZoneFreezeMargin[];
}
