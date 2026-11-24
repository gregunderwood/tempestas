import { DateTime } from 'luxon';
import { roundTo } from '../common/rounding';
import type {
  DeviceRole,
  DeviceRuntime,
  DeviceRuntimeDay,
  RelayState,
} from '@tempestas/domain';
import {
  MILLISECONDS_PER_SECOND,
  MINUTES_PER_HOUR,
} from '../common/time-units';
import {
  buildSpansByLine,
  type NodeSighting,
  type RuntimeTransition,
  type Span,
} from '../devices/relay-spans';

export type { NodeSighting, RuntimeTransition } from '../devices/relay-spans';

export interface RuntimeDevice {
  id: string;
  name: string;
  role: DeviceRole | null;
  nodeId: string;
  zoneId: string;
  timezone: string;
  addedAt: Date;
  inputBtuPerHour: number | null;
}

export interface EquipmentRuntimeInput {
  devices: readonly RuntimeDevice[];
  /** Every line's rows in the window, plus the row in force when it opened; any order. */
  transitions: readonly RuntimeTransition[];
  sightingsByNode: ReadonlyMap<string, NodeSighting>;
  days: number;
  now: Date;
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
// Natural Resources Canada gives propane 25.31 MJ/L, about 23,990 BTU per litre.
export const PROPANE_BTU_PER_LITRE = 24_000;

export function summariseEquipmentRuntime(
  input: EquipmentRuntimeInput,
): DeviceRuntime[] {
  const spansByLine = buildSpansByLine(
    input.transitions,
    input.sightingsByNode,
    input.now,
  );
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
  const addedAtMs = device.addedAt.getTime();
  const durations = dayWindows.map((window) =>
    measureDay(startNoEarlierThan(window, addedAtMs), spans),
  );
  const days = dayWindows.map((window, index) =>
    summariseDay(
      window,
      durations[index],
      runs,
      addedAtMs,
      device.inputBtuPerHour,
    ),
  );
  const totalOnMs = sumOf(durations.map((day) => day.onMs));
  return {
    deviceId: device.id,
    deviceName: device.name,
    role: device.role,
    nodeId: device.nodeId,
    zoneId: device.zoneId,
    timezone: device.timezone,
    addedAt: device.addedAt.toISOString(),
    days,
    totalHoursOn: toHours(totalOnMs),
    totalStarts: sumOf(days.map((day) => day.starts)),
    totalHoursUnknown: toHours(sumOf(durations.map((day) => day.unknownMs))),
    inputBtuPerHour: device.inputBtuPerHour,
    totalPropaneLitres: estimatePropaneLitres(
      totalOnMs,
      device.inputBtuPerHour,
    ),
  };
}

// Before a device existed there is nothing to know, so those hours are not counted as unknown.
function startNoEarlierThan(window: DayWindow, addedAtMs: number): DayWindow {
  return { ...window, fromMs: Math.max(window.fromMs, addedAtMs) };
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
  addedAtMs: number,
  inputBtuPerHour: number | null,
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
    isBeforeDeviceAdded: window.toMs <= addedAtMs,
    propaneLitres: estimatePropaneLitres(durations.onMs, inputBtuPerHour),
  };
}

// Unrounded and from known hours on only: unknown hours are never guessed at, and the browser rounds.
export function estimatePropaneLitres(
  onMs: number,
  inputBtuPerHour: number | null,
): number | null {
  if (inputBtuPerHour === null) return null;
  return (
    ((onMs / MILLISECONDS_PER_HOUR) * inputBtuPerHour) / PROPANE_BTU_PER_LITRE
  );
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
