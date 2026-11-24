import type { SystemStatus } from '@tempestas/domain';

export const FOLLOWER_NOTICE =
  'This controller is a follower; rules run on the leader';

export function isFollowing(status: SystemStatus | null): boolean {
  return status?.isLeading === false;
}
