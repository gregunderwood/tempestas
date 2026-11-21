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
import { BehaviorSubject, combineLatest, switchMap } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import {
  GAUGE_METRICS,
  sensorKey,
  type GaugeMetricKey,
  type DayNightStats,
  type Device,
  type Node,
  type SegmentStats,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { PageHeading } from '../../core/page-heading';
import { injectLiveDevices } from '../../core/live-devices';
import { injectLiveReadings } from '../../core/live-readings';
import { Gauge } from '../../shared/gauge/gauge';
import { metricsFor, nodeMetrics } from '../../shared/metrics';

/**
 * How often the statistics are re-queried. Slow on purpose: a min or max a
 * minute old is not misleading, and each refresh is three periods of
 * aggregate queries against the readings table on an SD card.
 */
const REFRESH_MS = 60_000;

/** setTimeout overflows past this and fires immediately. */
const MAX_TIMEOUT_MS = 2_147_483_647;

interface PeriodRow {
  period: string;
  span: string;
  inProgress: boolean;
  min: number | null;
  minAt: string | null;
  max: number | null;
  maxAt: string | null;
  average: number | null;
}

interface MetricBlock {
  key: GaugeMetricKey;
  label: string;
  unit: string;
  digits: string;
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

/**
 * One node in detail: what it reads now, and what it has done over the last
 * 24 hours.
 *
 * The window is a rolling 24 hours because that is what the readings API
 * returns when given no `days` - a calendar day would make the first reading
 * after midnight sit alone against an empty min and max.
 *
 * Every figure here can legitimately be null and renders as an em-dash. A
 * window with no valid CO2 has no CO2 average, and showing 0 would read as
 * extremely low - the one direction that runs the burner.
 */
@Component({
  selector: 'temp-node-detail',
  imports: [MatCardModule, DatePipe, RouterLink, Gauge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="crumb"><a routerLink="/nodes">← All nodes</a></nav>

    <mat-card appearance="outlined">
      <mat-card-header><mat-card-title>Now</mat-card-title></mat-card-header>
      <mat-card-content>
        @for (s of sensors(); track s.key) {
          <section class="sensor">
            @if (sensors().length > 1) {
              <h3 class="sensor__name">{{ s.reading.sensorId }}</h3>
            }
            <div class="gauges">
              @for (metric of s.metrics; track metric) {
                <temp-gauge [metricKey]="metric" [value]="s.reading[metric]" />
              }
            </div>
            <p class="sub taken">
              Taken {{ s.reading.createdAt | date: 'medium' }}
            </p>
          </section>
        } @empty {
          <p>No readings from this node.</p>
        }
      </mat-card-content>
    </mat-card>

    @if (devices().length > 0) {
      <mat-card appearance="outlined">
        <mat-card-header
          ><mat-card-title>Relays</mat-card-title></mat-card-header
        >
        <mat-card-content>
          <ul class="relays">
            @for (d of devices(); track d.id) {
              <li class="relay" [class.relay--on]="d.isOn">
                <div class="relay__head">
                  <span class="relay__name">{{ d.name }}</span>
                  <!-- In words, not colour: read on a phone in sunlight, and
                       this one means a propane burner is alight. -->
                  <span class="relay__state">{{ d.isOn ? 'ON' : 'off' }}</span>
                </div>
                <div class="relay__facts">
                  <span>BCM {{ d.gpio }}</span>
                  @if (d.role) {
                    <span>{{ d.role }}</span>
                  }
                  <!-- Whether anything is driving it is as important as its
                       state: an idle relay under manual control and one the
                       rules engine is deciding about look identical otherwise. -->
                  <span>{{ d.rulesEnabled ? 'automatic' : 'manual' }}</span>
                  @if (d.isOn && d.onAt) {
                    <span>since {{ d.onAt | date: 'HH:mm' }}</span>
                  } @else if (d.offAt) {
                    <span>since {{ d.offAt | date: 'HH:mm' }}</span>
                  }
                </div>
                <!-- The interlock is invisible otherwise, and "why is it not
                     coming on?" is the question it produces. -->
                @if (!d.isOn && !d.canTurnOn && d.canTurnOnAt) {
                  <div class="relay__hold">
                    held off until {{ d.canTurnOnAt | date: 'HH:mm:ss' }} ({{
                      d.onDelayDuration
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
        @if (stats(); as s) {
          <mat-card-subtitle>
            Daylight {{ s.daylight.startTime }}–{{ s.daylight.endTime }} ·
            {{ s.daylight.timezone }}
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
                        {{ fmt(row.min, block.digits) }}
                        @if (row.minAt) {
                          <span class="at">{{
                            row.minAt | date: 'HH:mm'
                          }}</span>
                        }
                      </td>
                      <td class="num">
                        {{ fmt(row.max, block.digits) }}
                        @if (row.maxAt) {
                          <span class="at">{{
                            row.maxAt | date: 'HH:mm'
                          }}</span>
                        }
                      </td>
                      <td class="num">{{ fmt(row.average, block.digits) }}</td>
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
    h1 {
      margin-bottom: 0.25rem;
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
      /* Three 9rem gauges plus gaps. Left alone they stretch across the card
         and the reading stops looking like one grouped measurement. */
      max-width: 30rem;
    }
    /* The gauge captions sit tight to the bottom of the arc, so without this
       the timestamp reads as part of the CO2 label. */
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
    /* The period still running reads differently from the completed one, and
       mistaking a part-day average for a full one is the whole point of the
       split. */
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
    .strong {
      font-weight: 600;
    }
    /* The clock time of an extreme matters as much as its value: a 38 °C peak
       at 14:00 is the greenhouse working, at 03:00 it is a fault. */
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

  /** Bound from the route, so the component works from a deep link. */
  readonly slug = input.required<string>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly reload = new BehaviorSubject<void>(undefined);
  private boundaryTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly liveReadings = injectLiveReadings().readings;
  private readonly allDevices = injectLiveDevices().devices;
  private readonly nodes = signal<Node[]>([]);
  protected readonly stats = signal<DayNightStats | null>(null);

  protected readonly node = computed(
    () => this.nodes().find((node) => node.slug === this.slug()) ?? null,
  );

  /**
   * The latest reading of each sensor on this node. The socket patches what
   * the API established, never replaces it.
   */
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

  protected readonly devices = computed<Device[]>(() =>
    this.allDevices().filter((device) => device.nodeId === this.slug()),
  );

  protected readonly blocks = computed<MetricBlock[]>(() => {
    // Newest first on screen. The API returns them chronologically, which is
    // the sane order for a caller, but the period running now is the one being
    // looked for and it belongs at the top.
    const segments = [...(this.stats()?.periods ?? [])].reverse();
    if (segments.length === 0) return [];
    // A pipe-probe node has no humidity: a block of dashes would read as a
    // broken sensor rather than one that was never there.
    return nodeMetrics(this.node()).map((key) => {
      const metric = GAUGE_METRICS[key];
      return {
        key,
        label: metric.label,
        unit: metric.unit,
        digits: `1.${metric.decimals}-${metric.decimals}`,
        periods: segments.map((seg) => ({
          period: periodLabel(seg),
          span: periodSpan(seg),
          inProgress: seg.inProgress,
          min: seg.stats.min[key]?.[key] ?? null,
          minAt: seg.stats.min[key]?.createdAt ?? null,
          max: seg.stats.max[key]?.[key] ?? null,
          maxAt: seg.stats.max[key]?.createdAt ?? null,
          average: seg.stats.average[key],
        })),
      };
    });
  });

  private readonly decimal = new DecimalPipe('en-US');

  /** An em-dash for anything absent. Never a zero. */
  protected fmt(value: number | null, digits: string): string {
    return value === null
      ? '—'
      : (this.decimal.transform(value, digits) ?? '—');
  }

  constructor() {
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));
    effect(() =>
      this.pageHeading.showPage(describeNodeHeading(this.slug(), this.node())),
    );

    // Driven off the route parameter rather than read once: a required input
    // has no value during construction, and moving between two nodes reuses
    // this component instead of building a new one.
    combineLatest([toObservable(this.slug), this.reload])
      .pipe(
        switchMap(([slug]) => this.api.dayNightStats({ nodeId: slug })),
        takeUntilDestroyed(),
      )
      .subscribe((stats) => {
        this.stats.set(stats);
        this.armBoundaryRefresh(stats.nextBoundary);
      });

    // The gauges above are pushed over the socket, but these figures are a
    // query. Without this the table silently freezes while the gauges keep
    // moving - and the running period is by definition still accumulating, so
    // it drifts further from the truth the longer the page is left open.
    const slow = setInterval(() => this.reload.next(), REFRESH_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(slow);
      clearTimeout(this.boundaryTimer);
    });
  }

  /**
   * Refresh the moment the running period ends, when every row shifts.
   *
   * The instant comes from the server, which owns the day/night boundary. A
   * client that worked it out itself would be a second definition of night,
   * free to disagree with the one driving the relay.
   */
  private armBoundaryRefresh(iso: string | null): void {
    clearTimeout(this.boundaryTimer);
    if (!iso) return;
    // A second past it, so the server's own clock has certainly crossed too.
    const delay = new Date(iso).getTime() - Date.now() + 1000;
    if (delay <= 0 || delay > MAX_TIMEOUT_MS) return;
    this.boundaryTimer = setTimeout(() => this.reload.next(), delay);
  }
}

/**
 * Kind plus a marker for the one still running.
 *
 * Deliberately not "last night" or "previous day": with three periods on
 * screen, which night is "last" depends on whether it is currently night, and
 * a label that is right half the time is worse than one that never says. The
 * dated span underneath carries the identity.
 */
function periodLabel(segment: SegmentStats): string {
  if (segment.inProgress) {
    return segment.kind === 'day' ? 'Day so far' : 'Night so far';
  }
  return segment.kind === 'day' ? 'Day' : 'Night';
}

/** Dated, because two rows can be the same kind on different days. */
function periodSpan(segment: SegmentStats): string {
  const from = new Date(segment.from);
  const started = from.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (segment.inProgress) {
    return `${started} – now`;
  }
  const to = new Date(segment.to).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${started} – ${to}`;
}
