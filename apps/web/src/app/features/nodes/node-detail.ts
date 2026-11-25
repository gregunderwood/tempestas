import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  asyncScheduler,
  BehaviorSubject,
  combineLatest,
  filter,
  switchMap,
  tap,
  throttleTime,
} from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import {
  GAUGE_METRICS,
  sensorKey,
  type GaugeMetricKey,
  type DayNightStats,
  type Device,
  type Node,
  type Reading,
  type SegmentStats,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { PageHeading } from '../../core/page-heading';
import { injectLiveDevices } from '../../core/live-devices';
import { injectLiveNodes } from '../../core/live-nodes';
import { refreshAfterSuccess } from '../../core/refresh-after-success';
import { injectLiveReadings } from '../../core/live-readings';
import { Gauge } from '../../shared/gauge/gauge';
import { metricsFor, nodeMetrics } from '../../shared/metrics';
import { LONGEST_TIMEOUT_MILLISECONDS } from '../../shared/time';
import { isHeldOffByInterlock } from '../devices/device-hold';
import { NodeUpdateCard, type UpdateConfirmation } from './node-update-card';

interface SentUpdate {
  nodeId: string;
  lastUpdateIdBefore: string | null;
}

// Each refresh is three periods of aggregates on an SD card; a reading arrives every 10 s.
export const STATS_REFRESH_THROTTLE_MILLISECONDS = 60_000;

const TRAILING_THROTTLE = { leading: false, trailing: true };

// A second past the boundary, so the server's own clock has certainly crossed it too.
const BOUNDARY_SLACK_MILLISECONDS = 1_000;

const ABSENT_FIGURE = '—';

const PERIOD_NAMES: Record<SegmentStats['kind'], string> = {
  day: 'Day',
  night: 'Night',
};

const HOUR_MINUTE_FORMAT: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
};

const PERIOD_START_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  ...HOUR_MINUTE_FORMAT,
};

interface PeriodRow {
  period: string;
  span: string;
  inProgress: boolean;
  minimum: number | null;
  minimumAt: string | null;
  maximum: number | null;
  maximumAt: string | null;
  average: number | null;
}

interface MetricBlock {
  key: GaugeMetricKey;
  label: string;
  unit: string;
  digitsInfo: string;
  periods: PeriodRow[];
}

function describeNodeHeading(slug: string, node: Node | null) {
  if (!node) {
    return { heading: slug, subtitle: '' };
  }
  const reachability = node.online ? 'online' : 'offline';
  return {
    heading: node.displayName,
    subtitle: `${slug} · ${node.kind} · ${reachability}`,
  };
}

@Component({
  selector: 'temp-node-detail',
  imports: [MatCardModule, DatePipe, RouterLink, Gauge, NodeUpdateCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="crumb"><a routerLink="/nodes">← All nodes</a></nav>

    <mat-card appearance="outlined">
      <mat-card-header><mat-card-title>Now</mat-card-title></mat-card-header>
      <mat-card-content>
        @for (sensor of sensors(); track sensor.key) {
          <section class="sensor">
            @if (sensors().length > 1) {
              <h3 class="sensor__name">{{ sensor.reading.sensorId }}</h3>
            }
            <div class="gauges">
              @for (metric of sensor.metrics; track metric) {
                <temp-gauge
                  [metricKey]="metric"
                  [value]="sensor.reading[metric]"
                />
              }
            </div>
            <p class="sub taken">
              Taken {{ sensor.reading.createdAt | date: 'medium' }}
            </p>
          </section>
        } @empty {
          <p>No readings from this node.</p>
        }
      </mat-card-content>
    </mat-card>

    @if (node(); as shownNode) {
      <temp-node-update-card
        [node]="shownNode"
        [isSending]="isSendingUpdate(shownNode)"
        (confirmed)="sendUpdate(shownNode, $event)"
      />
    }

    @if (devices().length > 0) {
      <mat-card appearance="outlined">
        <mat-card-header
          ><mat-card-title>Relays</mat-card-title></mat-card-header
        >
        <mat-card-content>
          <ul class="relays">
            @for (device of devices(); track device.id) {
              <li class="relay" [class.relay--on]="device.isOn">
                <div class="relay__head">
                  <span class="relay__name">{{ device.name }}</span>
                  <span class="relay__state">{{
                    device.isOn ? 'ON' : 'off'
                  }}</span>
                </div>
                <div class="relay__facts">
                  <span>BCM {{ device.gpio }}</span>
                  @if (device.role) {
                    <span>{{ device.role }}</span>
                  }
                  <span>{{
                    device.rulesEnabled ? 'automatic' : 'manual'
                  }}</span>
                  @if (findLastSwitchedAt(device); as switchedAt) {
                    <span>since {{ switchedAt | date: 'HH:mm' }}</span>
                  }
                </div>
                @if (isHeldOffByInterlock(device)) {
                  <div class="relay__hold">
                    held off until
                    {{ device.canTurnOnAt | date: 'HH:mm:ss' }} ({{
                      device.onDelayDuration
                    }}s minimum off)
                  </div>
                }
              </li>
            }
          </ul>
        </mat-card-content>
      </mat-card>
    }

    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Day and night</mat-card-title>
        @if (stats(); as dayNightStats) {
          <mat-card-subtitle>
            Daylight {{ dayNightStats.daylight.startTime }}–{{
              dayNightStats.daylight.endTime
            }}
            · {{ dayNightStats.daylight.timezone }}
          </mat-card-subtitle>
        }
      </mat-card-header>
      <mat-card-content>
        @if (blocks().length === 0) {
          <p>No day or night period to show.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">Min</th>
                  <th scope="col">Max</th>
                  <th scope="col">Average</th>
                </tr>
              </thead>
              @for (block of blocks(); track block.key) {
                <tbody>
                  <tr class="metric">
                    <th scope="rowgroup" colspan="4">
                      {{ block.label }}
                      <span class="unit">{{ block.unit }}</span>
                    </th>
                  </tr>
                  @for (row of block.periods; track row.period) {
                    <tr [class.running]="row.inProgress">
                      <th scope="row" class="period">
                        {{ row.period }}
                        <span class="span">{{ row.span }}</span>
                      </th>
                      <td class="num">
                        {{ formatFigure(row.minimum, block.digitsInfo) }}
                        @if (row.minimumAt) {
                          <span class="at">{{
                            row.minimumAt | date: 'HH:mm'
                          }}</span>
                        }
                      </td>
                      <td class="num">
                        {{ formatFigure(row.maximum, block.digitsInfo) }}
                        @if (row.maximumAt) {
                          <span class="at">{{
                            row.maximumAt | date: 'HH:mm'
                          }}</span>
                        }
                      </td>
                      <td class="num">
                        {{ formatFigure(row.average, block.digitsInfo) }}
                      </td>
                    </tr>
                  }
                </tbody>
              }
            </table>
          </div>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    :host {
      display: block;
    }
    .crumb {
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
    }
    .crumb a {
      color: var(--mat-sys-primary);
      text-decoration: none;
    }
    .crumb a:hover,
    .crumb a:focus-visible {
      text-decoration: underline;
    }
    .sub {
      opacity: 0.75;
      margin: 0 0 1rem;
      font-size: 0.9rem;
    }
    mat-card {
      margin-bottom: 1rem;
      max-width: 46rem;
    }
    .gauges {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 0.25rem;
      /* Three 9rem gauges and gaps, so they stay one grouped measurement. */
      max-width: 30rem;
    }
    /* Otherwise the timestamp reads as part of the CO2 gauge's caption. */
    .taken {
      margin-top: 1rem;
      margin-bottom: 0;
    }
    .sensor + .sensor {
      margin-top: 1.25rem;
    }
    .sensor__name {
      margin: 0 0 0.25rem;
      font-size: 0.95rem;
      font-weight: 500;
    }
    .relays {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .relay {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 0.5rem;
      padding: 0.6rem 0.8rem;
    }
    .relay--on {
      border-color: var(--temp-gauge-orange);
      background: color-mix(in srgb, var(--temp-gauge-orange) 12%, transparent);
    }
    .relay__head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
    }
    .relay__name {
      font-weight: 500;
    }
    .relay__state {
      font-weight: 700;
      letter-spacing: 0.06em;
      opacity: 0.7;
    }
    .relay--on .relay__state {
      color: var(--temp-gauge-orange);
      opacity: 1;
    }
    .relay__facts {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      font-size: 0.8rem;
      opacity: 0.75;
      margin-top: 0.15rem;
    }
    .relay__hold {
      font-size: 0.8rem;
      margin-top: 0.35rem;
      color: var(--temp-gauge-orange);
    }
    .table-scroll {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      padding: 0.6rem 0.5rem;
      text-align: right;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      white-space: nowrap;
    }
    thead th {
      font-size: 0.75rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.75;
      font-weight: 500;
    }
    th[scope='row'],
    thead th:first-child {
      text-align: left;
    }
    .metric th {
      text-align: left;
      padding-top: 1rem;
      font-size: 1rem;
      border-bottom: 2px solid var(--mat-sys-outline-variant);
    }
    tbody:first-of-type .metric th {
      padding-top: 0.35rem;
    }
    .period {
      font-weight: 400;
      opacity: 0.85;
      padding-left: 1rem;
      white-space: normal;
    }
    .span {
      display: block;
      font-size: 0.7rem;
      opacity: 0.6;
    }
    .running .period {
      font-weight: 600;
      opacity: 1;
    }
    tbody tr:last-child th,
    tbody tr:last-child td {
      border-bottom: none;
    }
    .unit {
      opacity: 0.6;
      font-weight: 400;
      font-size: 0.85em;
    }
    .num {
      font-size: 1.05rem;
    }
    .at {
      display: block;
      font-size: 0.7rem;
      opacity: 0.6;
      font-weight: 400;
    }
  `,
})
export class NodeDetail {
  private readonly api = inject(ApiService);
  private readonly pageHeading = inject(PageHeading);

  // Bound from the route, so the component works from a deep link.
  readonly slug = input.required<string>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly reload = new BehaviorSubject<void>(undefined);
  private boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  private newestReadingInStatsMilliseconds = Number.POSITIVE_INFINITY;

  private readonly liveReadings = injectLiveReadings().readings;
  private readonly allDevices = injectLiveDevices().devices;
  private readonly liveNodes = injectLiveNodes();
  private readonly nodes = this.liveNodes.nodes;
  protected readonly stats = signal<DayNightStats | null>(null);
  private readonly sentUpdate = signal<SentUpdate | null>(null);
  protected readonly isHeldOffByInterlock = isHeldOffByInterlock;

  protected readonly node = computed(
    () => this.nodes().find((node) => node.slug === this.slug()) ?? null,
  );

  protected readonly sensors = computed(() => {
    const node = this.node();
    return this.liveReadings()
      .filter((reading) => reading.nodeId === this.slug())
      .map((reading) => ({
        key: sensorKey(reading),
        reading,
        metrics: metricsFor(reading, node),
      }))
      .sort((first, second) => first.key.localeCompare(second.key));
  });

  private readonly newestReadingAt = computed(() =>
    findNewestReadingAt(this.sensors().map((sensor) => sensor.reading)),
  );

  protected readonly devices = computed<Device[]>(() =>
    this.allDevices().filter((device) => device.nodeId === this.slug()),
  );

  protected readonly blocks = computed<MetricBlock[]>(() => {
    const segments = sortNewestFirst(this.stats()?.periods ?? []);
    if (segments.length === 0) return [];
    return nodeMetrics(this.node()).map((key) =>
      buildMetricBlock(key, segments),
    );
  });

  private readonly decimalPipe = new DecimalPipe('en-US');

  constructor() {
    this.showNodeInHeading();
    this.followDayNightStats();
    this.refreshStatsOnNewReadings();
    this.destroyRef.onDestroy(() => clearTimeout(this.boundaryTimer));
  }

  protected formatFigure(value: number | null, digitsInfo: string): string {
    if (value === null) return ABSENT_FIGURE;
    return this.decimalPipe.transform(value, digitsInfo) ?? ABSENT_FIGURE;
  }

  protected sendUpdate(
    node: Node,
    { action, version }: UpdateConfirmation,
  ): void {
    const request =
      action === 'update'
        ? this.api.updateNode(node.id, { version })
        : this.api.rollBackNode(node.id, { version });
    this.sentUpdate.set({
      nodeId: node.id,
      lastUpdateIdBefore: node.updateSummary.lastUpdate?.id ?? null,
    });
    refreshAfterSuccess(
      request.pipe(tap({ error: () => this.sentUpdate.set(null) })),
      this.liveNodes.refresh,
    );
  }

  // Until the node itself shows the new update, or the button would come back before its progress.
  protected isSendingUpdate(node: Node): boolean {
    const sent = this.sentUpdate();
    return (
      sent?.nodeId === node.id &&
      (node.updateSummary.lastUpdate?.id ?? null) === sent.lastUpdateIdBefore
    );
  }

  protected findLastSwitchedAt(device: Device): string | null {
    if (device.isOn && device.onAt) return device.onAt;
    return device.offAt;
  }

  private showNodeInHeading(): void {
    effect(() =>
      this.pageHeading.showPage(describeNodeHeading(this.slug(), this.node())),
    );
  }

  private followDayNightStats(): void {
    combineLatest([toObservable(this.slug), this.reload])
      .pipe(
        tap(() => this.rememberNewestReadingInStats()),
        switchMap(([slug]) => this.api.dayNightStats({ nodeId: slug })),
        takeUntilDestroyed(),
      )
      .subscribe((stats) => {
        this.stats.set(stats);
        this.armBoundaryRefresh(stats.nextBoundary);
      });
  }

  private refreshStatsOnNewReadings(): void {
    toObservable(this.newestReadingAt)
      .pipe(
        filter((newestReadingAt) => this.isMissingFromStats(newestReadingAt)),
        throttleTime(
          STATS_REFRESH_THROTTLE_MILLISECONDS,
          asyncScheduler,
          TRAILING_THROTTLE,
        ),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.reload.next());
  }

  // Compared with the server's own timestamps, so the browser's clock cannot skew the throttle.
  private rememberNewestReadingInStats(): void {
    const newestReadingAt = this.newestReadingAt();
    this.newestReadingInStatsMilliseconds =
      newestReadingAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(newestReadingAt);
  }

  private isMissingFromStats(readingCreatedAt: string | null): boolean {
    if (readingCreatedAt === null) return false;
    return Date.parse(readingCreatedAt) > this.newestReadingInStatsMilliseconds;
  }

  private armBoundaryRefresh(nextBoundary: string | null): void {
    clearTimeout(this.boundaryTimer);
    if (!nextBoundary) return;
    const delay =
      new Date(nextBoundary).getTime() -
      Date.now() +
      BOUNDARY_SLACK_MILLISECONDS;
    if (isOutsideTimeoutRange(delay)) return;
    this.boundaryTimer = setTimeout(() => this.reload.next(), delay);
  }
}

function findNewestReadingAt(readings: readonly Reading[]): string | null {
  const timestamps = readings.map((reading) => reading.createdAt).sort();
  return timestamps[timestamps.length - 1] ?? null;
}

function isOutsideTimeoutRange(delay: number): boolean {
  return delay <= 0 || delay > LONGEST_TIMEOUT_MILLISECONDS;
}

function sortNewestFirst(segments: readonly SegmentStats[]): SegmentStats[] {
  return [...segments].reverse();
}

function buildMetricBlock(
  key: GaugeMetricKey,
  segments: readonly SegmentStats[],
): MetricBlock {
  const metric = GAUGE_METRICS[key];
  return {
    key,
    label: metric.label,
    unit: metric.unit,
    digitsInfo: `1.${metric.decimals}-${metric.decimals}`,
    periods: segments.map((segment) => buildPeriodRow(segment, key)),
  };
}

function buildPeriodRow(segment: SegmentStats, key: GaugeMetricKey): PeriodRow {
  const { min: minimum, max: maximum, average } = segment.stats;
  return {
    period: labelPeriod(segment),
    span: describePeriodSpan(segment),
    inProgress: segment.inProgress,
    minimum: minimum[key]?.[key] ?? null,
    minimumAt: minimum[key]?.createdAt ?? null,
    maximum: maximum[key]?.[key] ?? null,
    maximumAt: maximum[key]?.createdAt ?? null,
    average: average[key],
  };
}

function labelPeriod(segment: SegmentStats): string {
  const name = PERIOD_NAMES[segment.kind];
  return segment.inProgress ? `${name} so far` : name;
}

function describePeriodSpan(segment: SegmentStats): string {
  const started = new Date(segment.from).toLocaleString(
    undefined,
    PERIOD_START_FORMAT,
  );
  if (segment.inProgress) {
    return `${started} – now`;
  }
  const ended = new Date(segment.to).toLocaleTimeString(
    undefined,
    HOUR_MINUTE_FORMAT,
  );
  return `${started} – ${ended}`;
}
