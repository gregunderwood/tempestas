import { computed, inject, type Signal } from '@angular/core';
import type { RulesCycle } from '@tempestas/domain';
import { ApiService } from './api.service';
import { fetchOnce, type RequestState } from './fetch-once';
import { RealtimeService } from './realtime.service';

export interface LiveRulesCycle {
  cycle: Signal<RulesCycle | null>;
  requestState: Signal<RequestState>;
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
  const realtime = inject(RealtimeService);
  const fetched = fetchOnce(inject(ApiService).fetchLatestRulesCycle());
  return {
    cycle: computed(() =>
      pickNewerCycle(realtime.latestRulesCycle(), fetched.value()),
    ),
    requestState: fetched.requestState,
  };
}
