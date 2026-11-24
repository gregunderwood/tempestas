import { DateTime } from 'luxon';
import type {
  DeviceRole,
  DeviceRuntime,
  DeviceRuntimeDay,
} from '@tempestas/domain';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
} from '../common/time-units';

export interface RuntimeTransition {
  nodeId: string;
  pin: number;
  energised: boolean | null;
  deviceId: string | null;
  observedAt: Date;
}

export interface RuntimeDevice {
  id: string;
  name: string;
  role: DeviceRole | null;
  nodeId: string;
  zoneId: string;
  timezone: string;
}

export interface NodeSighting {
  isOnline: boolean;
  /** The later of its last connection and its latest reading. */
  lastHeardAt: Date | null;
}

export interface EquipmentRuntimeInput {
  devices: readonly RuntimeDevice[];
  /** Every line's rows in the window, plus the row in force when it opened; any order. */
  transitions: readonly RuntimeTransition[];
  sightingsByNode: ReadonlyMap<string, NodeSighting>;
  days: number;
  now: Date;
}

type RelayState = 'on' | 'off' | 'unknown';
type SpanEnding = 'transition' | 'now' | 'last-seen';

interface Span {
  deviceId: string | null;
  state: RelayState;
  fromMs: number;
  toMs: number;
  ending: SpanEnding;
}

interface Run {
  deviceId: string | null;
  fromMs: number;
  toMs: number;
  /** The relay was last known off before it, so this is a real start rather than a node reappearing. */
  isStart: boolean;
  /** Closed by a known off, so its length is measured rather than a lower bound. */
  isComplete: boolean;
  isCappedAtLastSeen: boolean;
}

interface DayWindow {
  date: string;
  fromMs: number;
  toMs: number;
}

interface DayDurations {
  onMs: number;
  offMs: number;
  unknownMs: number;
}

const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;
const HOUR_DECIMALS = 2;
const MINUTE_DECIMALS = 1;

export function summariseEquipmentRuntime(
  input: EquipmentRuntimeInput,
): DeviceRuntime[] {
  const spansByLine = buildSpansByLine(input);
  const spans = spansByLine.flat();
  const runs = spansByLine.flatMap(findLineRuns);
  return input.devices.map((device) =>
    summariseDevice(
      device,
      spans.filter((span) => span.deviceId === device.id),
      runs.filter((run) => run.deviceId === device.id),
      listLocalDays(input.now, device.timezone, input.days),
    ),
  );
}

function buildSpansByLine(input: EquipmentRuntimeInput): Span[][] {
  return [...groupByLine(input.transitions).values()].map((rows) =>
    mergeRepeatedStates(
      buildLineSpans(
        sortOldestFirst(rows),
        input.sightingsByNode.get(rows[0].nodeId),
        input.now.getTime(),
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
    byLine.set(lineKey, [...(byLine.get(lineKey) ?? []), transition]);
  }
  return byLine;
}

function sortOldestFirst(rows: RuntimeTransition[]): RuntimeTransition[] {
  return [...rows].sort(
    (first, second) => first.observedAt.getTime() - second.observedAt.getTime(),
  );
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
      ? { atMs: next.observedAt.getTime(), ending: 'transition' as const }
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

function findLineRuns(spans: Span[]): Run[] {
  const runs: Run[] = [];
  let lastKnownState: RelayState | null = null;
  spans.forEach((span, index) => {
    if (span.state === 'on') {
      runs.push({
        deviceId: span.deviceId,
        fromMs: span.fromMs,
        toMs: span.toMs,
        isStart: lastKnownState === 'off',
        isComplete: isClosedByKnownOff(span, spans[index + 1]),
        isCappedAtLastSeen: span.ending === 'last-seen',
      });
    }
    if (span.state !== 'unknown') lastKnownState = span.state;
  });
  return runs;
}

function isClosedByKnownOff(span: Span, next: Span | undefined): boolean {
  return span.ending === 'transition' && next?.state === 'off';
}

// Calendar days, never 24-hour blocks: a DST day is 23 or 25 hours long.
function listLocalDays(now: Date, timezone: string, days: number): DayWindow[] {
  const today = startOfLocalDay(now, timezone);
  const nowMs = now.getTime();
  const windows: DayWindow[] = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    const dayStart = today.minus({ days: daysAgo });
    const nextDayStart = dayStart.plus({ days: 1 });
    windows.push({
      date: dayStart.toISODate() ?? '',
      fromMs: dayStart.toMillis(),
      toMs: Math.min(nextDayStart.toMillis(), nowMs),
    });
  }
  return windows;
}

function startOfLocalDay(now: Date, timezone: string): DateTime {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  if (!local.isValid) {
    throw new RangeError(
      `Invalid timezone "${timezone}": ${local.invalidReason ?? 'unknown'}`,
    );
  }
  return local.startOf('day');
}

function summariseDevice(
  device: RuntimeDevice,
  spans: Span[],
  runs: Run[],
  dayWindows: DayWindow[],
): DeviceRuntime {
  const durations = dayWindows.map((window) => measureDay(window, spans));
  const days = dayWindows.map((window, index) =>
    summariseDay(window, durations[index], runs),
  );
  return {
    deviceId: device.id,
    deviceName: device.name,
    role: device.role,
    nodeId: device.nodeId,
    zoneId: device.zoneId,
    timezone: device.timezone,
    days,
    totalHoursOn: toHours(sumOf(durations.map((day) => day.onMs))),
    totalStarts: sumOf(days.map((day) => day.starts)),
    totalHoursUnknown: toHours(sumOf(durations.map((day) => day.unknownMs))),
  };
}

// Unknown is whatever is neither known on nor known off, so a gap in history is never counted as off.
function measureDay(window: DayWindow, spans: Span[]): DayDurations {
  const onMs = sumOverlaps(spans, 'on', window);
  const offMs = sumOverlaps(spans, 'off', window);
  const elapsedMs = Math.max(window.toMs - window.fromMs, 0);
  return { onMs, offMs, unknownMs: Math.max(elapsedMs - onMs - offMs, 0) };
}

function summariseDay(
  window: DayWindow,
  durations: DayDurations,
  runs: Run[],
): DeviceRuntimeDay {
  const startedThisDay = runs.filter(
    (run) => run.isStart && isWithin(run.fromMs, window),
  );
  return {
    date: window.date,
    hoursOn: toHours(durations.onMs),
    hoursOff: toHours(durations.offMs),
    hoursUnknown: toHours(durations.unknownMs),
    starts: startedThisDay.length,
    shortestRunMinutes: findShortestRunMinutes(startedThisDay),
    hasRunCappedAtLastSeen: runs.some(
      (run) => run.isCappedAtLastSeen && isTouching(run, window),
    ),
  };
}

// A whole run belongs to the day it started: splitting at midnight would invent two short runs.
function findShortestRunMinutes(startedThisDay: Run[]): number | null {
  const measured = startedThisDay
    .filter((run) => run.isComplete)
    .map((run) => run.toMs - run.fromMs);
  if (measured.length === 0) return null;
  return roundTo(
    Math.min(...measured) / MILLISECONDS_PER_MINUTE,
    MINUTE_DECIMALS,
  );
}

function sumOverlaps(
  spans: Span[],
  state: RelayState,
  window: DayWindow,
): number {
  return sumOf(
    spans
      .filter((span) => span.state === state)
      .map((span) => overlapMs(span, window)),
  );
}

function overlapMs(
  stretch: { fromMs: number; toMs: number },
  window: DayWindow,
): number {
  const startMs = Math.max(stretch.fromMs, window.fromMs);
  const endMs = Math.min(stretch.toMs, window.toMs);
  return Math.max(endMs - startMs, 0);
}

// Inclusive of a zero-length run: a node never heard after it switched on still ran.
function isTouching(
  stretch: { fromMs: number; toMs: number },
  window: DayWindow,
): boolean {
  return stretch.fromMs < window.toMs && stretch.toMs >= window.fromMs;
}

function isWithin(instantMs: number, window: DayWindow): boolean {
  return instantMs >= window.fromMs && instantMs < window.toMs;
}

function sumOf(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function toHours(milliseconds: number): number {
  return roundTo(milliseconds / MILLISECONDS_PER_HOUR, HOUR_DECIMALS);
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
