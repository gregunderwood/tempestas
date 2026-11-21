export enum ApiErrorCode {
  DeviceAlreadyOn = 'DEVICE_ALREADY_ON',
  DeviceAlreadyOff = 'DEVICE_ALREADY_OFF',
  DeviceCooldown = 'DEVICE_COOLDOWN',
  NodeOffline = 'NODE_OFFLINE',
  /** The node drove the pin but read back something else, so state is unknown. */
  ReadbackMismatch = 'READBACK_MISMATCH',
  NodeNotAdmitted = 'NODE_NOT_ADMITTED',
  /** Deleting an admitted node would cascade away its reading history. */
  NodeNotDeletable = 'NODE_NOT_DELETABLE',
  PinNotAvailable = 'PIN_NOT_AVAILABLE',
  HardwareUnreachable = 'HARDWARE_UNREACHABLE',
  /** Not a fault: the operator is on a follower, and the fix is to promote it. */
  ControllerIsFollower = 'CONTROLLER_IS_FOLLOWER',
  ValidationFailed = 'VALIDATION_FAILED',
  NotFound = 'NOT_FOUND',
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
