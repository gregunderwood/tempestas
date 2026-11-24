import {
  sensorKey,
  type DeviceRole,
  type DeviceRunHistory,
  type ProbeHistory,
  type RelaySpan,
  type RelayState,
  type TemperatureBucket,
  type ZoneHistory,
  type ZoneHistoryReport,
} from '@tempestas/domain';
import {
  buildSpansByLine,
  type NodeSighting,
  type RuntimeTransition,
  type Span,
} from '../devices/relay-spans';
import type { TemperatureBucketRow } from '../readings/readings.service';

export interface HistoryDevice {
  id: string;
  name: string;
  role: DeviceRole | null;
  nodeId: string;
  zoneId: string;
  addedAt: Date;
}

export interface HistoryNode {
  slug: string;
  zoneId: string | null;
}

export interface ZoneHistoryInput {
  zoneIds: readonly string[];
  nodes: readonly HistoryNode[];
  devices: readonly HistoryDevice[];
  /** Every line's rows in the window, plus the row in force when it opened; any order. */
  transitions: readonly RuntimeTransition[];
  sightingsByNode: ReadonlyMap<string, NodeSighting>;
  temperatureBuckets: readonly TemperatureBucketRow[];
  from: Date;
  now: Date;
}

interface Stretch {
  state: RelayState;
  fromMs: number;
  toMs: number;
}

export function buildZoneHistoryReport(
  input: ZoneHistoryInput,
): ZoneHistoryReport {
  const spans = buildSpansByLine(
    input.transitions,
    input.sightingsByNode,
    input.now,
  ).flat();
  return {
    from: input.from.toISOString(),
    to: input.now.toISOString(),
    zones: input.zoneIds.map((zoneId) =>
      buildZoneHistory(zoneId, spans, input),
    ),
  };
}

function buildZoneHistory(
  zoneId: string,
  spans: readonly Span[],
  input: ZoneHistoryInput,
): ZoneHistory {
  const zoneNodeSlugs = new Set(
    input.nodes
      .filter((node) => node.zoneId === zoneId)
      .map((node) => node.slug),
  );
  return {
    zoneId,
    probes: buildProbeHistories(
      input.temperatureBuckets.filter((bucket) =>
        zoneNodeSlugs.has(bucket.nodeId),
      ),
    ),
    devices: input.devices
      .filter((device) => device.zoneId === zoneId)
      .map((device) => buildDeviceRunHistory(device, spans, input)),
  };
}

function buildProbeHistories(
  buckets: readonly TemperatureBucketRow[],
): ProbeHistory[] {
  const byProbe = new Map<string, ProbeHistory>();
  for (const bucket of sortOldestFirst(buckets)) {
    const probeKey = sensorKey(bucket);
    const probe = byProbe.get(probeKey) ?? {
      nodeId: bucket.nodeId,
      sensorId: bucket.sensorId,
      buckets: [],
    };
    probe.buckets.push(toTemperatureBucket(bucket));
    byProbe.set(probeKey, probe);
  }
  return [...byProbe.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([, probe]) => probe);
}

function sortOldestFirst(
  buckets: readonly TemperatureBucketRow[],
): TemperatureBucketRow[] {
  return [...buckets].sort(
    (first, second) => first.at.getTime() - second.at.getTime(),
  );
}

function toTemperatureBucket(row: TemperatureBucketRow): TemperatureBucket {
  return {
    at: row.at.toISOString(),
    averageC: row.averageC,
    lowestC: row.lowestC,
    highestC: row.highestC,
    sampleCount: row.sampleCount,
  };
}

function buildDeviceRunHistory(
  device: HistoryDevice,
  spans: readonly Span[],
  input: ZoneHistoryInput,
): DeviceRunHistory {
  // Before a device existed there is nothing to know, so that time is left out rather than unknown.
  const startMs = Math.max(input.from.getTime(), device.addedAt.getTime());
  const ownSpans = spans.filter((span) => span.deviceId === device.id);
  return {
    deviceId: device.id,
    deviceName: device.name,
    role: device.role,
    nodeId: device.nodeId,
    spans: coverWindow(ownSpans, startMs, input.now.getTime()).map(toRelaySpan),
  };
}

// Unknown fills every gap, so a stretch with no history is never drawn as off.
function coverWindow(
  spans: readonly Span[],
  startMs: number,
  endMs: number,
): Stretch[] {
  const stretches: Stretch[] = [];
  let coveredUntilMs = startMs;
  for (const span of [...spans].sort(compareByStart)) {
    const fromMs = Math.max(span.fromMs, coveredUntilMs);
    const toMs = Math.min(span.toMs, endMs);
    if (toMs <= fromMs) continue;
    appendStretch(stretches, {
      state: 'unknown',
      fromMs: coveredUntilMs,
      toMs: fromMs,
    });
    appendStretch(stretches, { state: span.state, fromMs, toMs });
    coveredUntilMs = toMs;
  }
  appendStretch(stretches, {
    state: 'unknown',
    fromMs: coveredUntilMs,
    toMs: endMs,
  });
  return stretches;
}

function compareByStart(first: Span, second: Span): number {
  return first.fromMs - second.fromMs;
}

function appendStretch(stretches: Stretch[], stretch: Stretch): void {
  if (stretch.toMs <= stretch.fromMs) return;
  const previous = stretches[stretches.length - 1];
  if (previous?.state === stretch.state && previous.toMs === stretch.fromMs) {
    previous.toMs = stretch.toMs;
    return;
  }
  stretches.push({ ...stretch });
}

function toRelaySpan(stretch: Stretch): RelaySpan {
  return {
    state: stretch.state,
    from: new Date(stretch.fromMs).toISOString(),
    to: new Date(stretch.toMs).toISOString(),
  };
}
