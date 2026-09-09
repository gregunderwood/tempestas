import type { NodeId } from '../nodes/node.model';

/** The literal electrical level written to the pad. */
export type GpioLevel = 0 | 1;

/**
 * What a device is FOR, which is what automation binds to.
 *
 * The old system resolved devices by display-name string ('Lights',
 * 'CO2 Generator'), so renaming a device in the UI silently disabled its rule.
 * Roles are not unique - several devices may share one, and all of them receive
 * the same decision, each still filtered by its own `rulesEnabled`.
 */
export enum DeviceRole {
  Lights = 'lights',
  Co2Generator = 'co2_generator',
  ExhaustFan = 'exhaust_fan',
}

export interface Device {
  id: string;
  nodeId: NodeId;
  zoneId: string;
  name: string;
  description: string | null;
  /** Meaningful only within its node: pin 17 on a Pi and on an ESP32 differ. */
  gpio: number;
  /** Anti-short-cycle minimum-off time, in seconds. */
  onDelayDuration: number;
  onAt: string | null;
  offAt: string | null;
  /**
   * The level that means ON for this device. Active-high vs active-low is
   * per-device data, not a constant: four of the five existing relays are
   * active-LOW, one is active-HIGH. Replaces the old `on_state`, which arrived
   * over the wire as bool, string or int depending on the code path.
   */
  onLevel: GpioLevel;
  rulesEnabled: boolean;
  role: DeviceRole | null;

  /** Derived server-side from onAt/offAt, never persisted. */
  isOn: boolean;
  /** Lets the UI disable the button instead of failing the request. */
  canTurnOn: boolean;
  canTurnOnAt: string | null;
}

export interface CreateDevicePayload {
  nodeId: NodeId;
  zoneId?: string;
  name: string;
  description?: string | null;
  gpio: number;
  onDelayDuration: number;
  onLevel: GpioLevel;
  rulesEnabled?: boolean;
  role?: DeviceRole | null;
}

export type UpdateDevicePayload = Partial<Omit<CreateDevicePayload, 'nodeId'>>;

export interface PatchDeviceRulesPayload {
  rulesEnabled: boolean;
}
