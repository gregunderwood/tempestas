// Never guessed on real hardware: two heartbeating leaders both get obeyed. See docs/Multi-Controller.md.
export type ControllerRole = 'leader' | 'follower';

export const CONTROLLER_ROLE = 'CONTROLLER_ROLE';

const DEVELOPMENT_DEFAULT_ROLE: ControllerRole = 'leader';

export class ControllerRoleError extends Error {}

export function resolveControllerRole(
  configuredRole: string | undefined,
  isDrivingRealHardware: boolean,
): ControllerRole {
  const role = configuredRole?.trim().toLowerCase();

  if (!role) {
    return defaultRoleOrRefuse(isDrivingRealHardware);
  }
  if (!isControllerRole(role)) {
    throw new ControllerRoleError(
      `CONTROLLER_ROLE="${configuredRole}" is not a role; use "leader" or "follower".`,
    );
  }
  return role;
}

function defaultRoleOrRefuse(isDrivingRealHardware: boolean): ControllerRole {
  if (isDrivingRealHardware) {
    throw new ControllerRoleError(
      'CONTROLLER_ROLE is required when HARDWARE_DRIVER=mqtt. ' +
        'Set it to "leader" on the one box that commands, "follower" on every other. ' +
        'There is no safe default: two leaders both get obeyed.',
    );
  }
  return DEVELOPMENT_DEFAULT_ROLE;
}

function isControllerRole(value: string): value is ControllerRole {
  return value === 'leader' || value === 'follower';
}
