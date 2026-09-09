/**
 * The old API returned errors inside HTTP 200 bodies as `{ error: "..." }`,
 * with no interceptor and no `catchError` anywhere in the client. These are
 * real status codes with a machine-readable code.
 */
export enum ApiErrorCode {
  DeviceAlreadyOn = 'DEVICE_ALREADY_ON',
  DeviceAlreadyOff = 'DEVICE_ALREADY_OFF',
  DeviceCooldown = 'DEVICE_COOLDOWN',
  NodeOffline = 'NODE_OFFLINE',
  NodeNotAdmitted = 'NODE_NOT_ADMITTED',
  /** Deleting an admitted node would cascade away its reading history. */
  NodeNotDeletable = 'NODE_NOT_DELETABLE',
  PinNotAvailable = 'PIN_NOT_AVAILABLE',
  HardwareUnreachable = 'HARDWARE_UNREACHABLE',
  ValidationFailed = 'VALIDATION_FAILED',
  NotFound = 'NOT_FOUND',
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
