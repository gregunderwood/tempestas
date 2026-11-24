import type {
  Device,
  DeviceRunHistory,
  ZoneHistory,
  ZoneHistoryReport,
} from '@tempestas/domain';
import {
  dropWhatTheFetchCovered,
  WINDOW_MILLISECONDS,
  type PushedProbe,
  type PushedReadings,
} from '../../core/pushed-readings';
import { buildRunStrip, type RunStrip } from './run-strips';
import {
  buildTemperatureChart,
  type TemperatureChart,
  type TemperatureZone,
} from './temperature-lines';
import {
  buildClockFormatter,
  buildTimeLabels,
  type PositionedLabel,
  type TimeWindow,
} from './time-axis';

export interface ZoneHistoryChart extends TemperatureChart {
  timeLabels: PositionedLabel[];
  strips: RunStrip[];
}

export interface HistoryZone extends TemperatureZone {
  zoneId: string;
  timezone: string;
}

export interface ZoneHistoryChartsInput {
  report: ZoneHistoryReport;
  zones: readonly HistoryZone[];
  pushedReadings: PushedReadings;
  zoneIdByNodeSlug: ReadonlyMap<string, string>;
  pushedDevices: readonly Device[];
  now: number;
}

export function buildZoneHistoryCharts(
  input: ZoneHistoryChartsInput,
): Map<string, ZoneHistoryChart> {
  const timeWindow = {
    fromMs: input.now - WINDOW_MILLISECONDS,
    toMs: input.now,
  };
  const freshProbes = [
    ...dropWhatTheFetchCovered(input.pushedReadings, input.report.to).values(),
  ];
  const charts = new Map<string, ZoneHistoryChart>();
  for (const zone of input.zones) {
    const history = input.report.zones.find(
      (candidate) => candidate.zoneId === zone.zoneId,
    );
    if (!history) continue;
    const zoneProbes = freshProbes.filter(
      (probe) => input.zoneIdByNodeSlug.get(probe.nodeId) === zone.zoneId,
    );
    charts.set(
      zone.zoneId,
      buildZoneHistoryChart(zone, history, zoneProbes, input, timeWindow),
    );
  }
  return charts;
}

function buildZoneHistoryChart(
  zone: HistoryZone,
  history: ZoneHistory,
  pushedProbes: readonly PushedProbe[],
  input: ZoneHistoryChartsInput,
  timeWindow: TimeWindow,
): ZoneHistoryChart {
  const formatClock = buildClockFormatter(zone.timezone);
  return {
    ...buildTemperatureChart(
      zone,
      history.probes,
      pushedProbes,
      timeWindow,
      formatClock,
    ),
    timeLabels: buildTimeLabels(timeWindow, formatClock),
    strips: history.devices.map((device) =>
      buildRunStrip(device, findPushedDevice(input, device), timeWindow),
    ),
  };
}

function findPushedDevice(
  input: ZoneHistoryChartsInput,
  device: DeviceRunHistory,
): Device | null {
  return (
    input.pushedDevices.find((pushed) => pushed.id === device.deviceId) ?? null
  );
}
