import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import {
  sensorKey,
  type Device,
  type Node,
  type Reading,
  type RulesTick,
  type Zone,
} from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import {
  NO_DEVICES,
  withPushes,
  type FetchedDevices,
} from '../../core/device-pushes';
import { RealtimeService } from '../../core/realtime.service';
import { formatDuration, zoneCards } from './zone-view';

/**
 * Every zone: the rules it runs, and what they are doing right now.
 *
 * Read-only. The rules are changed by reviewed SQL, and the card says where.
 *
 * Live without polling. The REST calls are first paint only; after that each
 * rules cycle arrives as `rules:evaluation`, readings as `reading:latest` and
 * device changes as `device:state`. The one timer is the clock that ages
 * readings and counts cooldowns down - it fetches nothing.
 */
@Component({
  selector: 'temp-zones-page',
  imports: [MatCardModule, RouterLink, DatePipe, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Zones</h1>

    @if (cards().length === 0) {
      <mat-card appearance="outlined">
        <mat-card-content><p>No zones yet.</p></mat-card-content>
      </mat-card>
    }

    <div class="zones">
      @for (zone of cards(); track zone.id) {
        <mat-card
          appearance="outlined"
          class="zone"
          [class.zone--failing]="zone.failure"
        >
          <mat-card-header>
            <mat-card-title>{{ zone.name }}</mat-card-title>
            <mat-card-subtitle>
              @if (zone.localTime) {
                {{ zone.localTime }} {{ zone.timezone }} ·
              }
              @if (zone.evaluatedAgoS === null) {
                not evaluated yet
              } @else {
                evaluated {{ age(zone.evaluatedAgoS) }} ago
              }
            </mat-card-subtitle>
          </mat-card-header>

          <mat-card-content>
            @if (zone.failure) {
              <p class="alert" role="alert">
                <span aria-hidden="true">&#9888;</span>
                <strong>Not being evaluated.</strong> {{ zone.failure }}
              </p>
            } @else if (zone.evaluationOld && zone.evaluatedAgoS !== null) {
              <p class="alert" role="alert">
                <span aria-hidden="true">&#9888;</span>
                <strong
                  >Rules last ran {{ age(zone.evaluatedAgoS) }} ago.</strong
                >
                What follows may no longer be true.
              </p>
            }
            @for (problem of zone.problems; track $index) {
              <p class="alert">
                <span aria-hidden="true">&#9888;</span> {{ problem }}
              </p>
            }

            <section class="probes" aria-label="Probes">
              <p class="policy">{{ zone.policy }}</p>
              <ul>
                @for (p of zone.probes; track p.key) {
                  <li
                    class="probe"
                    [class.probe--picked]="p.tag"
                    [class.probe--quiet]="p.quiet"
                  >
                    <span class="probe__name">{{ p.label }}</span>
                    <span class="probe__value"
                      >{{ p.temperatureC | number: '1.1-1' }} °C</span
                    >
                    <span class="probe__age">
                      @if (p.quiet) {
                        <span aria-hidden="true">&#9888;</span> quiet
                        {{ age(p.ageS) }}
                      } @else {
                        {{ age(p.ageS) }} ago
                      }
                    </span>
                    @if (p.tag) {
                      <span class="probe__tag">{{ p.tag }}</span>
                    }
                  </li>
                } @empty {
                  <li class="muted">No probes reporting in this zone.</li>
                }
              </ul>
            </section>

            @if (zone.daylight; as day) {
              <section class="daylight" aria-label="Daylight window">
                <div
                  class="strip"
                  role="img"
                  [attr.aria-label]="
                    'Daylight ' + hm(day.start) + ' to ' + hm(day.end)
                  "
                >
                  @for (seg of daySegments(day.start, day.end); track $index) {
                    <span
                      class="strip__day"
                      [style.left.%]="seg.from"
                      [style.width.%]="seg.width"
                    ></span>
                  }
                  @if (day.now !== null) {
                    <span
                      class="strip__now"
                      [style.left.%]="(day.now / 1440) * 100"
                    ></span>
                  }
                </div>
                <div class="strip__labels">
                  <span>00:00</span>
                  <span>day {{ hm(day.start) }}–{{ hm(day.end) }}</span>
                  <span>24:00</span>
                </div>
              </section>
            }

            @for (rule of zone.rules; track rule.role) {
              <section
                class="rule"
                [class.rule--unowned]="!rule.owned"
                [attr.aria-label]="rule.label + ' rule'"
              >
                <header class="rule__head">
                  <h2>{{ rule.label }}</h2>
                  @if (!rule.owned) {
                    <span class="rule__decision tone-idle"
                      >not driven by tempestas</span
                    >
                  } @else if (rule.decision; as d) {
                    <span class="rule__decision" [class]="'tone-' + d.tone">{{
                      d.headline
                    }}</span>
                  }
                </header>

                @if (rule.problem) {
                  <p class="alert">
                    <span aria-hidden="true">&#9888;</span> {{ rule.problem }}
                  </p>
                }
                @for (bar of rule.bars; track bar.caption) {
                  <figure class="bar">
                    <figcaption>
                      <span>{{ bar.caption }}</span>
                      <span class="bar__now">{{ bar.now }}</span>
                    </figcaption>
                    <div
                      class="bar__track"
                      role="img"
                      [attr.aria-label]="bar.description"
                    >
                      @for (seg of bar.segments; track $index) {
                        <span
                          class="bar__seg seg-{{ seg.kind }}"
                          [style.left.%]="seg.from"
                          [style.width.%]="seg.width"
                        ></span>
                      }
                      @if (bar.marker; as m) {
                        @if (m.offScale) {
                          <span
                            class="bar__offscale bar__offscale--{{
                              m.offScale
                            }}"
                            aria-hidden="true"
                            >{{ m.offScale === 'high' ? '▶' : '◀' }}</span
                          >
                        } @else {
                          <span
                            class="bar__marker"
                            [style.left.%]="m.pct"
                          ></span>
                        }
                      }
                    </div>
                    <div class="bar__labels" aria-hidden="true">
                      @for (l of bar.labels; track $index) {
                        <span [style.left.%]="l.pct">{{ l.text }}</span>
                      }
                    </div>
                  </figure>
                }
                @for (note of rule.notes; track $index) {
                  <p class="note">{{ note }}</p>
                }
                @if (rule.stale) {
                  <p class="note">{{ rule.stale }}</p>
                }

                @if (rule.devices.length > 0) {
                  <ul class="devices" aria-label="Devices">
                    @for (dev of rule.devices; track dev.id) {
                      <li
                        class="device"
                        [class.device--on]="dev.isOn"
                        [class.device--failed]="dev.failed"
                      >
                        <span class="device__state">{{
                          dev.isOn ? 'ON' : 'off'
                        }}</span>
                        <span class="device__name">
                          <a [routerLink]="['/nodes', dev.nodeId]">{{
                            dev.name
                          }}</a>
                          <span class="muted">{{ dev.where }}</span>
                        </span>
                        <span class="device__detail">
                          @if (dev.manual) {
                            <strong class="manual">manual</strong> ·
                          }
                          @if (dev.cooldownS !== null) {
                            can restart in {{ age(dev.cooldownS) }} ·
                          }
                          {{ dev.outcome ?? 'no decision yet' }}
                        </span>
                      </li>
                    }
                  </ul>
                } @else if (rule.owned) {
                  <p class="note muted">
                    No device has this role in this zone.
                  </p>
                }
              </section>
            }

            <p class="source muted">
              Read-only: changed by reviewed SQL, not from here. Last changed
              {{ zone.updatedAt | date: 'MMM d, y, HH:mm' }}.
            </p>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: `
    .zones {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 24rem), 36rem));
      gap: 1rem;
      align-items: start;
    }
    .zone--failing {
      border-color: var(--temp-gauge-red);
    }
    .alert {
      color: var(--temp-gauge-red);
      margin: 0 0 0.75rem;
    }
    .muted {
      opacity: 0.7;
    }
    .policy {
      margin: 0 0 0.35rem;
      font-size: 0.9rem;
    }
    .probes ul,
    .devices {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .probe {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.25rem 0.75rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }
    .probe__name {
      min-width: 5rem;
    }
    .probe__value {
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .probe__age {
      font-size: 0.85rem;
      opacity: 0.7;
    }
    .probe--picked .probe__value {
      color: var(--temp-gauge-blue);
    }
    .probe__tag {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--temp-gauge-blue);
    }
    .probe--quiet .probe__age {
      color: var(--temp-gauge-orange);
      opacity: 1;
      font-weight: 500;
    }
    .daylight {
      margin-top: 1rem;
    }
    .strip {
      position: relative;
      height: 0.6rem;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
      overflow: hidden;
    }
    .strip__day {
      position: absolute;
      top: 0;
      bottom: 0;
      background: color-mix(in srgb, var(--temp-gauge-orange) 45%, transparent);
    }
    .strip__now {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--mat-sys-on-surface);
    }
    .strip__labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.75rem;
      opacity: 0.7;
    }
    .rule {
      margin-top: 1.25rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    .rule--unowned {
      opacity: 0.55;
    }
    .rule__head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.25rem 1rem;
    }
    .rule__head h2 {
      font-size: 1.05rem;
      margin: 0;
    }
    .rule__decision {
      font-size: 0.85rem;
      font-weight: 600;
    }
    .tone-on {
      color: var(--temp-gauge-orange);
    }
    .tone-off,
    .tone-hold,
    .tone-idle {
      opacity: 0.8;
    }
    .tone-warn {
      color: var(--temp-gauge-red);
    }
    .bar {
      margin: 0.75rem 0 0.25rem;
    }
    .bar figcaption {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      font-size: 0.8rem;
      margin-bottom: 0.3rem;
    }
    .bar figcaption > span:first-child {
      opacity: 0.7;
    }
    .bar__now {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .bar__offscale {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      font-size: 0.85rem;
      line-height: 1;
      color: var(--mat-sys-on-surface);
    }
    .bar__offscale--high {
      right: 2px;
    }
    .bar__offscale--low {
      left: 2px;
    }
    .bar__track {
      position: relative;
      height: 0.9rem;
      border-radius: 4px;
      background: var(--mat-sys-surface-container-highest);
    }
    .bar__seg {
      position: absolute;
      top: 0;
      bottom: 0;
    }
    .bar__seg:first-child {
      border-radius: 4px 0 0 4px;
    }
    .bar__seg:last-of-type {
      border-radius: 0 4px 4px 0;
    }
    .seg-on {
      background: color-mix(in srgb, var(--temp-gauge-orange) 55%, transparent);
    }
    .seg-band {
      background: repeating-linear-gradient(
        135deg,
        var(--mat-sys-outline-variant) 0 4px,
        transparent 4px 8px
      );
    }
    .seg-off {
      background: var(--mat-sys-surface-container-highest);
    }
    .bar__marker {
      position: absolute;
      top: -0.3rem;
      bottom: -0.3rem;
      width: 3px;
      margin-left: -1.5px;
      background: var(--mat-sys-on-surface);
      border-radius: 2px;
    }
    .bar__labels {
      position: relative;
      height: 1rem;
      font-size: 0.75rem;
      opacity: 0.75;
    }
    .bar__labels span {
      position: absolute;
      transform: translateX(-50%);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .note {
      margin: 0.25rem 0 0;
      font-size: 0.85rem;
    }
    .devices {
      margin-top: 0.6rem;
      display: grid;
      gap: 0.4rem;
    }
    .device {
      display: grid;
      grid-template-columns: 3rem 1fr;
      gap: 0 0.5rem;
      padding: 0.4rem 0.6rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 8px;
    }
    .device__state {
      grid-row: span 2;
      align-self: center;
      font-weight: 700;
      letter-spacing: 0.06em;
      opacity: 0.7;
    }
    .device__name a {
      color: inherit;
      margin-right: 0.5rem;
    }
    .device__detail {
      font-size: 0.85rem;
    }
    .device--on {
      border-color: var(--temp-gauge-orange);
      background: color-mix(in srgb, var(--temp-gauge-orange) 12%, transparent);
    }
    .device--on .device__state {
      color: var(--temp-gauge-orange);
      opacity: 1;
    }
    .device--failed {
      border-color: var(--temp-gauge-red);
    }
    .manual {
      color: var(--temp-gauge-purple);
    }
    .source {
      margin: 1.25rem 0 0;
      font-size: 0.8rem;
    }
  `,
})
export class ZonesPage {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);

  private readonly zones = signal<Zone[]>([]);
  private readonly nodes = signal<Node[]>([]);
  /** First paint only: the same message the socket pushes, failures included. */
  private readonly fetchedTick = signal<RulesTick | null>(null);
  private readonly fetchedReadings = signal<Reading[]>([]);
  private readonly fetchedDevices = signal<FetchedDevices>(NO_DEVICES);
  /** Every push newer than the fetch, not only the newest one. */
  private readonly devices = computed<Device[]>(() =>
    withPushes(this.fetchedDevices(), this.realtime.devicePushes()),
  );
  /** The page's only clock. Ages and cooldowns read it; nothing is fetched on it. */
  private readonly now = signal(Date.now());

  private readonly readings = computed<Reading[]>(() => {
    const merged = new Map(
      this.fetchedReadings().map((r) => [sensorKey(r), r]),
    );
    for (const [key, reading] of Object.entries(this.realtime.readings())) {
      merged.set(key, reading);
    }
    return [...merged.values()];
  });

  readonly cards = computed(() => {
    const tick = newer(this.realtime.rulesTick(), this.fetchedTick());
    return zoneCards({
      zones: this.zones(),
      evaluations: tick?.evaluations ?? [],
      failures: tick?.failingZones ?? [],
      nodes: this.nodes(),
      readings: this.readings(),
      devices: this.devices(),
      now: this.now(),
    });
  });

  constructor() {
    this.api.zones().subscribe((zones) => this.zones.set(zones));
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));
    this.api.rulesTick().subscribe((t) => this.fetchedTick.set(t));
    this.api.latestReadings().subscribe((r) => this.fetchedReadings.set(r));
    const requestedAt = Date.now();
    this.api
      .devices()
      .subscribe((devices) =>
        this.fetchedDevices.set({ devices, requestedAt }),
      );

    const timer = setInterval(() => this.now.set(Date.now()), 1_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  age(seconds: number): string {
    return formatDuration(seconds);
  }

  hm(minutes: number): string {
    const h = Math.floor(minutes / 60);
    return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  /** The daylight window as strip segments; a window may cross midnight. */
  daySegments(start: number, end: number): { from: number; width: number }[] {
    const pct = (m: number) => (m / 1440) * 100;
    return start <= end
      ? [{ from: pct(start), width: pct(end - start) }]
      : [
          { from: pct(start), width: 100 - pct(start) },
          { from: 0, width: pct(end) },
        ];
  }
}

/** Whichever cycle is more recent: the socket's, or the one fetched for first paint. */
function newer(a: RulesTick | null, b: RulesTick | null): RulesTick | null {
  if (!a) return b;
  if (!b) return a;
  return a.at >= b.at ? a : b;
}
