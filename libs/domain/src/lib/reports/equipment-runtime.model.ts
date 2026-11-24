import type { DeviceRole } from '../devices/device.model';
import type { NodeId } from '../nodes/node.model';

export const EQUIPMENT_RUNTIME_DEFAULT_DAYS = 30;
export const EQUIPMENT_RUNTIME_MAX_DAYS = 90;

export interface EquipmentRuntimeQuery {
  /** Calendar days in each device's zone, today included. */
  days?: number;
}

/** One calendar day in the device's zone; the three hour figures add up to the day's length so far. */
export interface DeviceRuntimeDay {
  /** `YYYY-MM-DD`, in the device's zone. */
  date: string;
  hoursOn: number;
  hoursOff: number;
  /** An `energised = null` span, a node gone quiet, or no history yet. Unknown is not off. */
  hoursUnknown: number;
  /** Runs that began this day after the relay was last known off. */
  starts: number;
  /** Of the runs that began this day and ended in a known off; null when there were none. */
  shortestRunMinutes: number | null;
  /** A run this day had no closing transition, so it was cut at the node's last-seen time. */
  hasRunCappedAtLastSeen: boolean;
}

export interface DeviceRuntime {
  deviceId: string;
  deviceName: string;
  role: DeviceRole | null;
  nodeId: NodeId;
  zoneId: string;
  timezone: string;
  /** Oldest first, ending with today so far. */
  days: DeviceRuntimeDay[];
  totalHoursOn: number;
  totalStarts: number;
  totalHoursUnknown: number;
}

export interface EquipmentRuntimeReport {
  days: number;
  generatedAt: string;
  devices: DeviceRuntime[];
}
