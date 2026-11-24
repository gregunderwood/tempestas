import type { RelayState } from '@tempestas/domain';
import { sortOldestFirst } from '../common/sort-oldest-first';

export interface RuntimeTransition {
  nodeId: string;
  pin: number;
  energised: boolean | null;
  deviceId: string | null;
  observedAt: Date;
  /** Written when the node dropped, so whatever ran before it is cut at that moment. */
  isNodeOffline: boolean;
}

export interface NodeSighting {
  isOnline: boolean;
  /** The later of its last connection and its latest reading. */
  lastHeardAt: Date | null;
}

export type SpanEnding = 'transition' | 'now' | 'last-seen';

export interface Span {
  deviceId: string | null;
  state: RelayState;
  fromMs: number;
  toMs: number;
  ending: SpanEnding;
}

export function buildSpansByLine(
  transitions: readonly RuntimeTransition[],
  sightingsByNode: ReadonlyMap<string, NodeSighting>,
  now: Date,
): Span[][] {
  return [...groupByLine(transitions).values()].map((rows) =>
    mergeRepeatedStates(
      buildLineSpans(
        sortOldestFirst(rows, (row) => row.observedAt),
        sightingsByNode.get(rows[0].nodeId),
        now.getTime(),
      ),
    ),
  );
}

function groupByLine(
  transitions: readonly RuntimeTransition[],
): Map<string, RuntimeTransition[]> {
  const byLine = new Map<string, RuntimeTransition[]>();
  for (const transition of transitions) {
    const lineKey = `${transition.nodeId}:${transition.pin}`;
    const lineRows = byLine.get(lineKey);
    if (lineRows) {
      lineRows.push(transition);
    } else {
      byLine.set(lineKey, [transition]);
    }
  }
  return byLine;
}

function buildLineSpans(
  rows: RuntimeTransition[],
  sighting: NodeSighting | undefined,
  nowMs: number,
): Span[] {
  return rows.map((row, index) => {
    const fromMs = row.observedAt.getTime();
    const next = rows[index + 1];
    const end = next
      ? resolveClosedEnd(next)
      : resolveOpenEnd(fromMs, sighting, nowMs);
    return {
      deviceId: row.deviceId,
      state: toRelayState(row.energised),
      fromMs,
      toMs: end.atMs,
      ending: end.ending,
    };
  });
}

function resolveClosedEnd(next: RuntimeTransition): {
  atMs: number;
  ending: SpanEnding;
} {
  return {
    atMs: next.observedAt.getTime(),
    ending: next.isNodeOffline ? 'last-seen' : 'transition',
  };
}

// An offline node sent no closing transition, so what it last did after it was last heard is unknown.
function resolveOpenEnd(
  fromMs: number,
  sighting: NodeSighting | undefined,
  nowMs: number,
): { atMs: number; ending: SpanEnding } {
  if (sighting?.isOnline) {
    return { atMs: nowMs, ending: 'now' };
  }
  const lastHeardMs = sighting?.lastHeardAt?.getTime() ?? fromMs;
  return {
    atMs: Math.min(Math.max(lastHeardMs, fromMs), nowMs),
    ending: 'last-seen',
  };
}

function toRelayState(energised: boolean | null): RelayState {
  if (energised === null) return 'unknown';
  return energised ? 'on' : 'off';
}

function mergeRepeatedStates(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && isSameStretch(previous, span)) {
      merged[merged.length - 1] = {
        ...previous,
        toMs: span.toMs,
        ending: span.ending,
      };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function isSameStretch(previous: Span, next: Span): boolean {
  return previous.state === next.state && previous.deviceId === next.deviceId;
}
