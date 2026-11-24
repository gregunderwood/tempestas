import type {
  ClimateSample,
  DecisionOutcome,
  DeviceRole,
  RulesCycle,
  RulesEvaluation,
  SystemStatus,
} from '@tempestas/domain';
import {
  chooseDecisionTone,
  describeDecision,
  describeDispatch,
  labelRole,
  type DecisionTone,
} from '../zones/zone-words';
import { isFollowing } from '../../shared/leadership';
import { secondsSince } from '../../shared/time';

export const UNKNOWN_VALUE = '—';

const OUTCOMES_THAT_REACHED_THE_RELAY: ReadonlySet<string> = new Set([
  'applied',
  'already-in-state',
]);

export type SystemTone = 'calm' | 'warn' | 'alarm';

export interface SystemState {
  headline: string;
  tone: SystemTone;
}

export interface SystemFacts {
  isConnected: boolean;
  status: SystemStatus | null;
  cycle: RulesCycle | null;
}

export interface ZoneTile {
  key: string;
  zoneSlug: string;
  roleLabel: string;
  reading: string;
  decision: string;
  unappliedBecause: string | null;
  tone: DecisionTone;
  decidedSecondsAgo: number;
}

export function describeSystemState(facts: SystemFacts): SystemState {
  const { isConnected, status, cycle } = facts;
  if (!isConnected) {
    return {
      headline: 'Offline: showing the last state received',
      tone: 'alarm',
    };
  }
  if (isFollowing(status)) {
    return {
      headline: 'Following: another server runs the rules',
      tone: 'warn',
    };
  }
  const failingZones =
    cycle?.failingZones.map((failure) => failure.zoneSlug) ?? [];
  if (failingZones.length > 0) {
    return {
      headline: `Rules failing in ${listNames(failingZones)}`,
      tone: 'alarm',
    };
  }
  const quietZones = listZonesWhere(
    cycle,
    (evaluation) => evaluation.staleRoles.length > 0,
  );
  if (quietZones.length > 0 || status?.sensorStale) {
    const where =
      quietZones.length > 0
        ? listNames(quietZones)
        : listNames(status?.staleRoles ?? []);
    return { headline: `Sensors quiet in ${where}`, tone: 'alarm' };
  }
  if (!cycle) {
    return { headline: 'Waiting for the first rules cycle', tone: 'warn' };
  }
  const warningZones = listZonesWhere(cycle, (evaluation) =>
    evaluation.decisions.some(
      (decision) => chooseDecisionTone(decision) === 'warn',
    ),
  );
  if (warningZones.length > 0) {
    return {
      headline: `Needs a look in ${listNames(warningZones)}`,
      tone: 'warn',
    };
  }
  return { headline: 'All zones running normally', tone: 'calm' };
}

export function buildZoneTiles(
  cycle: RulesCycle | null,
  now: number,
): ZoneTile[] {
  if (!cycle) return [];
  return cycle.evaluations.flatMap((evaluation) =>
    evaluation.decisions.filter(isOwnedDecision).map((decision) => ({
      key: `${evaluation.zoneSlug}/${decision.role}`,
      zoneSlug: evaluation.zoneSlug,
      roleLabel: labelRole(decision.role),
      reading: formatClimate(
        decision.role,
        evaluation.climateByRole[decision.role],
      ),
      decision: describeDecision(decision),
      unappliedBecause: describeUnappliedDispatch(decision),
      tone: chooseDecisionTone(decision),
      decidedSecondsAgo: secondsSince(evaluation.evaluatedAt, now),
    })),
  );
}

function describeUnappliedDispatch(decision: DecisionOutcome): string | null {
  const unapplied = decision.dispatched.find(
    (dispatch) => !OUTCOMES_THAT_REACHED_THE_RELAY.has(dispatch.outcome),
  );
  return describeDispatch(unapplied);
}

export function isOwnedDecision(decision: DecisionOutcome): boolean {
  return decision.reason !== 'role-not-owned';
}

function formatClimate(
  role: DeviceRole,
  climate: ClimateSample | undefined,
): string {
  if (!climate) return UNKNOWN_VALUE;
  if (role === 'co2_generator') {
    return climate.co2Ppm === null
      ? UNKNOWN_VALUE
      : `${Math.round(climate.co2Ppm)} ppm`;
  }
  return `${climate.temperatureC.toFixed(1)} °C`;
}

function listZonesWhere(
  cycle: RulesCycle | null,
  isMatch: (evaluation: RulesEvaluation) => boolean,
): string[] {
  return (
    cycle?.evaluations
      .filter(isMatch)
      .map((evaluation) => evaluation.zoneSlug) ?? []
  );
}

function listNames(names: readonly string[]): string {
  return [...new Set(names)].join(', ');
}
