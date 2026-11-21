import type { NodeId } from '../nodes/node.model';

export type GpioLevel = 0 | 1;

/** What automation binds to, never the display name. Several devices may share one. */
export enum DeviceRole {
  Lights = 'lights',
  Co2Generator = 'co2_generator',
  ExhaustFan = 'exhaust_fan',
  Heater = 'heater',
  HeatTape = 'heat_tape',
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
  /** Per device, because the existing relays mix active-high and active-low. */
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
