import { computed, inject, type Signal } from '@angular/core';
import type { Node } from '@tempestas/domain';
import { ApiService } from './api.service';
import {
  injectLiveSource,
  isNewerThanFetch,
  type FetchedPayload,
  type SourceState,
} from './live-source';
import type { PushedNode } from './node-pushes';
import { RealtimeService } from './realtime.service';

export interface LiveNodes {
  nodes: Signal<Node[]>;
  sourceState: Signal<SourceState>;
  refresh(): void;
}

export function applyNewerNodePushes(
  fetched: FetchedPayload<Node[]> | null,
  pushes: ReadonlyMap<string, PushedNode>,
): Node[] {
  if (!fetched) return [];
  const fetchedIds = new Set(fetched.payload.map((node) => node.id));
  const pushedSinceFetch = [...pushes.values()]
    .filter((pushed) => isNewerThanFetch(pushed, fetched))
    .map((pushed) => pushed.node);
  const pushedById = new Map(pushedSinceFetch.map((node) => [node.id, node]));

  const updated = fetched.payload.map(
    (fetchedNode) => pushedById.get(fetchedNode.id) ?? fetchedNode,
  );
  const announcedSinceFetch = pushedSinceFetch.filter(
    (node) => !fetchedIds.has(node.id),
  );
  return sortBySlug([...updated, ...announcedSinceFetch]);
}

function sortBySlug(nodes: Node[]): Node[] {
  return nodes.sort((first, second) => first.slug.localeCompare(second.slug));
}

export function injectLiveNodes(): LiveNodes {
  const api = inject(ApiService);
  const realtime = inject(RealtimeService);
  const source = injectLiveSource((options) => api.nodes(options));
  return {
    nodes: computed(() =>
      applyNewerNodePushes(source.latest(), realtime.nodePushes()),
    ),
    sourceState: source.sourceState,
    refresh: source.refresh,
  };
}
