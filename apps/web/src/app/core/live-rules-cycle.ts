import { computed, inject, signal, type Signal } from '@angular/core';
import type { RulesCycle } from '@tempestas/domain';
import { ApiService } from './api.service';
import { RealtimeService } from './realtime.service';

export function pickNewerCycle(
  socketCycle: RulesCycle | null,
  fetchedCycle: RulesCycle | null,
): RulesCycle | null {
  if (!socketCycle) return fetchedCycle;
  if (!fetchedCycle) return socketCycle;
  return socketCycle.at >= fetchedCycle.at ? socketCycle : fetchedCycle;
}

export function injectLiveRulesCycle(): Signal<RulesCycle | null> {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const fetched = signal<RulesCycle | null>(null);
  api.fetchLatestRulesCycle().subscribe((cycle) => fetched.set(cycle));
  return computed(() => pickNewerCycle(realtime.latestRulesCycle(), fetched()));
}
