import type { DeviceRole, RulesEvaluation } from '@tempestas/domain';

// The union across zones: a quiet sensor anywhere is worth surfacing everywhere.
export function collectStaleRoles(
  evaluations: readonly RulesEvaluation[],
): DeviceRole[] {
  return [
    ...new Set(evaluations.flatMap((evaluation) => evaluation.staleRoles)),
  ];
}
