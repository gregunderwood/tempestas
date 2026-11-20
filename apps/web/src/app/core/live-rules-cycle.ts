import { computed, inject, type Signal } from '@angular/core';
import type { RulesCycle } from '@tempestas/domain';
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

export function injectLiveRulesCycle(): LiveRulesCycle {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource(
    () => api.fetchLatestRulesCycle(),
    () => realtime.latestRulesCycle() !== null,
  );
  return {
    cycle: computed(() =>
      pickNewerCycle(
        realtime.latestRulesCycle(),
        source.latest()?.response ?? null,
      ),
    ),
    sourceState: source.sourceState,
  };
}
