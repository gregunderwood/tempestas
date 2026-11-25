import type {
  CreateDevicePayload,
  Device,
  DeviceRole,
  GpioLevel,
  Node,
  NodeId,
  UpdateDevicePayload,
} from '@tempestas/domain';

export const MIN_INPUT_BTU_PER_HOUR = 1;
export const MIN_ON_DELAY_SECONDS = 0;
export const DEFAULT_ON_DELAY_SECONDS = 300;

export interface DeviceFormValue {
  name: string;
  nodeId: NodeId | null;
  zoneId: string | null;
  role: DeviceRole | null;
  gpio: number | null;
  onLevel: GpioLevel | null;
  onDelayDuration: number | null;
  inputBtuPerHour: number | null;
}

export interface CompleteDeviceFormValue extends DeviceFormValue {
  nodeId: NodeId;
  gpio: number;
  onLevel: GpioLevel;
  onDelayDuration: number;
}

export interface PinChoice {
  pin: number;
  usedBy: string | null;
}

export const ON_LEVEL_CHOICES: readonly {
  level: GpioLevel;
  label: string;
}[] = [
  { level: 0, label: 'Low (0): active-low relay' },
  { level: 1, label: 'High (1): active-high relay' },
];

// No on level by default: guessing it wrong runs the relay whenever tempestas means off.
export function emptyDeviceForm(): DeviceFormValue {
  return {
    name: '',
    nodeId: null,
    zoneId: null,
    role: null,
    gpio: null,
    onLevel: null,
    onDelayDuration: DEFAULT_ON_DELAY_SECONDS,
    inputBtuPerHour: null,
  };
}

export function readDeviceForm(device: Device): DeviceFormValue {
  return {
    name: device.name,
    nodeId: device.nodeId,
    zoneId: device.zoneId,
    role: device.role,
    gpio: device.gpio,
    onLevel: device.onLevel,
    onDelayDuration: device.onDelayDuration,
    inputBtuPerHour: device.inputBtuPerHour,
  };
}

export function buildCreatePayload(
  value: CompleteDeviceFormValue,
): CreateDevicePayload {
  return {
    nodeId: value.nodeId,
    ...(value.zoneId === null ? {} : { zoneId: value.zoneId }),
    ...buildSharedFields(value),
  };
}

export function buildUpdatePayload(
  value: CompleteDeviceFormValue,
): UpdateDevicePayload {
  return {
    ...(value.zoneId === null ? {} : { zoneId: value.zoneId }),
    ...buildSharedFields(value),
  };
}

function buildSharedFields(
  value: CompleteDeviceFormValue,
): Omit<CreateDevicePayload, 'nodeId' | 'zoneId'> {
  return {
    name: value.name.trim(),
    role: value.role,
    gpio: value.gpio,
    onLevel: value.onLevel,
    onDelayDuration: value.onDelayDuration,
    inputBtuPerHour: value.inputBtuPerHour,
  };
}

export function exposesPins(node: Node): boolean {
  return (node.capabilities.gpio?.pins.length ?? 0) > 0;
}

export function listPinChoices(
  node: Node | undefined,
  devices: readonly Device[],
  editedDevice: Device | null,
): PinChoice[] {
  const exposedPins = node?.capabilities.gpio?.pins ?? [];
  const pins = new Set(exposedPins);
  if (editedDevice) pins.add(editedDevice.gpio);
  const otherDevicesOnNode = devices.filter(
    (device) => device.nodeId === node?.slug && device.id !== editedDevice?.id,
  );
  return [...pins]
    .sort((first, second) => first - second)
    .map((pin) => ({
      pin,
      usedBy:
        otherDevicesOnNode.find((device) => device.gpio === pin)?.name ?? null,
    }));
}

export function describeRemapping(
  device: Device,
  value: DeviceFormValue,
): string[] {
  const warnings: string[] = [];
  if (value.gpio !== null && value.gpio !== device.gpio) {
    warnings.push(describePinChange(device, value.gpio));
  }
  if (value.onLevel !== null && value.onLevel !== device.onLevel) {
    warnings.push(describeOnLevelChange(device, value.onLevel));
  }
  return warnings;
}

function describePinChange(device: Device, newPin: number): string {
  return (
    `Moving to pin ${newPin} changes which relay ${device.name} drives. ` +
    `Its next command goes to pin ${newPin}; pin ${device.gpio} is left as it is now, ` +
    `with nothing in tempestas driving it.`
  );
}

function describeOnLevelChange(device: Device, newOnLevel: GpioLevel): string {
  return (
    `On level ${newOnLevel} changes what "on" means for ${device.name}. ` +
    `Nothing switches, but the relay's current level is read the new way, ` +
    `so it may show as on straight after saving, and its next command drives the relay the other way.`
  );
}
