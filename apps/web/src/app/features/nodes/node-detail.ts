import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import {
  GAUGE_METRICS,
  type GaugeMetricKey,
  type Node,
  type Reading,
  type ReadingStats,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { Gauge } from '../../shared/gauge/gauge';

interface MetricRow {
  key: GaugeMetricKey;
  label: string;
  unit: string;
  digits: string;
  now: number | null;
  min: number | null;
  minAt: string | null;
  max: number | null;
  maxAt: string | null;
  average: number | null;
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

    <h1>{{ node()?.displayName ?? slug() }}</h1>
    <p class="sub">
      {{ slug() }}
      @if (node(); as n) {
        · {{ n.kind }} · {{ n.online ? 'online' : 'offline' }}
      }
    </p>

    <mat-card appearance="outlined">
      <mat-card-header><mat-card-title>Now</mat-card-title></mat-card-header>
      <mat-card-content>
        @if (reading(); as r) {
          <div class="gauges">
            <temp-gauge metricKey="temperature" [value]="r.temperature" />
            <temp-gauge metricKey="humidity" [value]="r.humidity" />
            <temp-gauge metricKey="co2" [value]="r.co2" />
          </div>
          <p class="sub">Taken {{ r.createdAt | date: 'medium' }}</p>
        } @else {
          <p>No readings from this node.</p>
        }
      </mat-card-content>
    </mat-card>

    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Last 24 hours</mat-card-title>
        @if (stats(); as s) {
          <mat-card-subtitle>
            {{ s.from | date: 'short' }} — {{ s.to | date: 'short' }}
          </mat-card-subtitle>
        }
      </mat-card-header>
      <mat-card-content>
        @if (rows().length === 0) {
          <p>No readings in this window.</p>
        } @else {
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Now</th>
                  <th scope="col">Min</th>
                  <th scope="col">Max</th>
                  <th scope="col">Average</th>
                </tr>
              </thead>
              <tbody>
                @for (row of rows(); track row.key) {
                  <tr>
                    <th scope="row">
                      {{ row.label }} <span class="unit">{{ row.unit }}</span>
                    </th>
                    <td class="num strong">
                      {{ fmt(row.now, row.digits) }}
                    </td>
                    <td class="num">
                      {{ fmt(row.min, row.digits) }}
                      @if (row.minAt) {
                        <span class="at">{{ row.minAt | date: 'HH:mm' }}</span>
                      }
                    </td>
                    <td class="num">
                      {{ fmt(row.max, row.digits) }}
                      @if (row.maxAt) {
                        <span class="at">{{ row.maxAt | date: 'HH:mm' }}</span>
                      }
                    </td>
                    <td class="num">{{ fmt(row.average, row.digits) }}</td>
                  </tr>
                }
              </tbody>
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
  private readonly realtime = inject(RealtimeService);

  /** Bound from the route, so the component works from a deep link. */
  readonly slug = input.required<string>();

  private readonly latest = signal<Reading[]>([]);
  private readonly nodes = signal<Node[]>([]);
  protected readonly stats = signal<ReadingStats | null>(null);

  protected readonly node = computed(
    () => this.nodes().find((n) => n.slug === this.slug()) ?? null,
  );

  /** The socket patches what the API established, never replaces it. */
  protected readonly reading = computed<Reading | null>(
    () =>
      this.realtime.readings()[this.slug()] ??
      this.latest().find((r) => r.nodeId === this.slug()) ??
      null,
  );

  protected readonly rows = computed<MetricRow[]>(() => {
    const s = this.stats();
    const now = this.reading();
    if (!s) return [];
    return (['temperature', 'humidity', 'co2'] as GaugeMetricKey[]).map(
      (key) => {
        const metric = GAUGE_METRICS[key];
        return {
          key,
          label: metric.label,
          unit: metric.unit,
          digits: `1.${metric.decimals}-${metric.decimals}`,
          now: now?.[key] ?? null,
          min: s.min[key]?.[key] ?? null,
          minAt: s.min[key]?.createdAt ?? null,
          max: s.max[key]?.[key] ?? null,
          maxAt: s.max[key]?.createdAt ?? null,
          average: s.average[key],
        };
      },
    );
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
    this.api.latestReadings().subscribe((all) => this.latest.set(all));

    // Driven off the route parameter rather than read once: a required input
    // has no value during construction, and moving between two nodes reuses
    // this component instead of building a new one.
    //
    // No `days` in the query - the readings API treats its absence as a
    // rolling 24 hours, which is the window this screen claims to show.
    toObservable(this.slug)
      .pipe(
        switchMap((slug) => this.api.stats({ nodeId: slug })),
        takeUntilDestroyed(),
      )
      .subscribe((stats) => this.stats.set(stats));
  }
}
