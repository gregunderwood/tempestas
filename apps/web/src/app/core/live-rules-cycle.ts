import { computed, inject, type Signal } from '@angular/core';
import type { RulesCycle, SystemStatus } from '@tempestas/domain';
import { ApiService } from './api.service';
import { injectLiveSource, type SourceState } from './live-source';
import { RealtimeService } from './realtime.service';

export interface LiveRulesCycle {
  cycle: Signal<RulesCycle | null>;
  sourceState: Signal<SourceState>;
}

export function pickNewerCycle(
  socketCycle: RulesCycle | null,
  fetchedCycle: RulesCycle | null,
): RulesCycle | null {
  if (!socketCycle) return fetchedCycle;
  if (!fetchedCycle) return socketCycle;
  return socketCycle.at >= fetchedCycle.at ? socketCycle : fetchedCycle;
}

// A follower runs no rules, so whatever cycle it last saw is history, not the current state.
export function chooseCurrentCycle(
  status: SystemStatus | null,
  socketCycle: RulesCycle | null,
  fetchedCycle: RulesCycle | null,
): RulesCycle | null {
  if (status?.isLeading === false) return null;
  return pickNewerCycle(socketCycle, fetchedCycle);
}

export function injectLiveRulesCycle(): LiveRulesCycle {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource(
    (options) => api.fetchLatestRulesCycle(options),
    () => realtime.latestRulesCycle() !== null,
  );
  return {
    cycle: computed(() =>
      chooseCurrentCycle(
        realtime.status(),
        realtime.latestRulesCycle(),
        source.latest()?.payload ?? null,
      ),
    ),
    sourceState: source.sourceState,
  };
}
