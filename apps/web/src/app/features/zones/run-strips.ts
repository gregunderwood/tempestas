import type {
  Device,
  DeviceRunHistory,
  RelaySpan,
  RelayState,
} from '@tempestas/domain';
import { MILLISECONDS_PER_SECOND } from '../../shared/time';
import { toPercent, type TimeWindow } from './time-axis';
import { formatDuration } from './zone-words';

export interface RunSegment {
  state: RelayState;
  fromPercent: number;
  widthPercent: number;
}

export interface RunStrip {
  deviceId: string;
  name: string;
  summary: string;
  screenReaderText: string;
  segments: RunSegment[];
}

interface Stretch {
  state: RelayState;
  fromMs: number;
  toMs: number;
}

export function buildRunStrip(
  device: DeviceRunHistory,
  pushedDevice: Device | null,
  timeWindow: TimeWindow,
): RunStrip {
  const stretches = clipToWindow(
    applyPushedSwitch(
      extendToNow(device.spans, timeWindow),
      pushedDevice,
      timeWindow,
    ),
    timeWindow,
  );
  const summary = describeRuns(
    sumStateMs(stretches, 'on'),
    countStarts(stretches),
    sumStateMs(stretches, 'unknown'),
  );
  return {
    deviceId: device.deviceId,
    name: device.deviceName,
    summary,
    screenReaderText: `${device.deviceName}, last 24 hours: ${summary}.`,
    segments: stretches.map((stretch) => ({
      state: stretch.state,
      fromPercent: toPercent(stretch.fromMs - timeWindow.fromMs, timeWindow),
      widthPercent: toPercent(stretch.toMs - stretch.fromMs, timeWindow),
    })),
  };
}

function extendToNow(
  spans: readonly RelaySpan[],
  timeWindow: TimeWindow,
): Stretch[] {
  return spans.map((span, index) => ({
    state: span.state,
    fromMs: Date.parse(span.from),
    toMs:
      index === spans.length - 1
        ? Math.max(Date.parse(span.to), timeWindow.toMs)
        : Date.parse(span.to),
  }));
}

function applyPushedSwitch(
  stretches: Stretch[],
  pushedDevice: Device | null,
  timeWindow: TimeWindow,
): Stretch[] {
  const last = stretches[stretches.length - 1];
  const switchedAt = pushedDevice?.isOn
    ? pushedDevice.onAt
    : pushedDevice?.offAt;
  if (!last || !pushedDevice || !switchedAt) return stretches;
  const pushedState: RelayState = pushedDevice.isOn ? 'on' : 'off';
  const switchedAtMs = Date.parse(switchedAt);
  const isNewerThanHistory =
    switchedAtMs > last.fromMs && last.state !== pushedState;
  if (!isNewerThanHistory) return stretches;
  return [
    ...stretches.slice(0, -1),
    { ...last, toMs: switchedAtMs },
    { state: pushedState, fromMs: switchedAtMs, toMs: timeWindow.toMs },
  ];
}

function clipToWindow(stretches: Stretch[], timeWindow: TimeWindow): Stretch[] {
  return stretches
    .map((stretch) => ({
      state: stretch.state,
      fromMs: Math.max(stretch.fromMs, timeWindow.fromMs),
      toMs: Math.min(stretch.toMs, timeWindow.toMs),
    }))
    .filter((stretch) => stretch.toMs > stretch.fromMs);
}

function sumStateMs(stretches: readonly Stretch[], state: RelayState): number {
  return stretches
    .filter((stretch) => stretch.state === state)
    .reduce((total, stretch) => total + stretch.toMs - stretch.fromMs, 0);
}

function countStarts(stretches: readonly Stretch[]): number {
  return stretches.filter((stretch, index) =>
    isStartAfterKnownOff(stretches[index - 1], stretch),
  ).length;
}

function isStartAfterKnownOff(
  previous: Stretch | undefined,
  stretch: Stretch,
): boolean {
  return stretch.state === 'on' && previous?.state === 'off';
}

function describeRuns(onMs: number, starts: number, unknownMs: number): string {
  const parts = [
    onMs === 0 ? 'never on' : `on ${formatMilliseconds(onMs)}`,
    `${starts} ${starts === 1 ? 'start' : 'starts'}`,
  ];
  if (unknownMs > 0) parts.push(`unknown ${formatMilliseconds(unknownMs)}`);
  return parts.join(' · ');
}

function formatMilliseconds(milliseconds: number): string {
  return formatDuration(milliseconds / MILLISECONDS_PER_SECOND);
}
