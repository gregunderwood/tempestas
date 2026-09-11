/**
 * Leader or follower. The one thing that must never be guessed.
 *
 * Only the leader heartbeats, and a node binds to whoever heartbeated most
 * recently - epoch fencing is not built yet, so two heartbeating servers would
 * make nodes ping-pong their binding and obey both. That is the exact failure
 * the whole design exists to prevent, so the role is REQUIRED whenever the
 * server is talking to a real broker. Defaulting it would mean a second box
 * deployed without the variable becomes a second leader in silence.
 *
 * See docs/Multi-Controller.md.
 */
export type ControllerRole = 'leader' | 'follower';

export const CONTROLLER_ROLE = 'CONTROLLER_ROLE';

export class ControllerRoleError extends Error {}

/**
 * @param raw          the CONTROLLER_ROLE value, if any
 * @param requiresRole true when the server drives real hardware, so omitting
 *                     it is a deployment mistake rather than a dev convenience
 */
export function resolveControllerRole(
  raw: string | undefined,
  requiresRole: boolean,
): ControllerRole {
  const value = raw?.trim().toLowerCase();

  if (!value) {
    if (requiresRole) {
      throw new ControllerRoleError(
        'CONTROLLER_ROLE is required when HARDWARE_DRIVER=mqtt. ' +
          'Set it to "leader" on the one box that commands, "follower" on every other. ' +
          'There is no safe default: two leaders both get obeyed.',
      );
    }
    return 'leader';
  }

  if (value !== 'leader' && value !== 'follower') {
    throw new ControllerRoleError(
      `CONTROLLER_ROLE="${raw}" is not a role; use "leader" or "follower".`,
    );
  }
  return value;
}
