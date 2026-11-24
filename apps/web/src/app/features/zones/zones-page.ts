import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  type Signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { injectLiveSource, type SourceState } from '../../core/live-source';
import { injectLiveDevices } from '../../core/live-devices';
import { injectLiveReadings } from '../../core/live-readings';
import { injectLiveRulesCycle } from '../../core/live-rules-cycle';
import { injectLiveZoneHistory } from '../../core/live-zone-history';
import { RealtimeService } from '../../core/realtime.service';
import { injectServerNow } from '../../core/server-now';
import { injectCardArrangement } from '../../shared/arrange/card-arrangement';
import { FOLLOWER_NOTICE, isFollowing } from '../../shared/leadership';
import { Pinboard } from '../../shared/pinboard/pinboard';
import {
  buildZoneCards,
  describeZoneSubtitle,
  type ZoneCard,
} from './zone-view';
import { formatDuration } from './zone-words';
import { ZoneHistoryPanel } from './zone-history-panel';
import type { SensorSource, Zone } from '@tempestas/domain';
import {
  buildZoneHistoryCharts,
  findControllingSources,
  type HistoryZone,
  type ZoneHistoryChart,
} from './zone-history-view';

const CLOCK_TICK_MILLISECONDS = 1_000;
// A minute is under a pixel on a phone-width day.
const HISTORY_TICK_MILLISECONDS = 30_000;
const ZONE_COLUMN_MINIMUM_REM = 24;
const ZONE_COLUMN_MAXIMUM_REM = 36;
export const ZONES_CARD_ORDER_KEY = 'tempestas.card-order.zones';

function identifyZoneCard(zone: ZoneCard): string {
  return zone.id;
}

function nameZoneCard(zone: ZoneCard): string {
  return zone.name;
}

function toHistoryZone(card: ZoneCard, zone: Zone | undefined): HistoryZone {
  return {
    zoneId: card.id,
    timezone: card.timezone,
    decidingProbeKeys: card.probes
      .filter((probe) => probe.isTemperatureDeciding)
      .map((probe) => probe.key),
    controllingSources: findDrawableControllingSources(zone),
  };
}

// A config the card cannot draw gets a problem on its card, so the chart just leaves its sources out.
function findDrawableControllingSources(
  zone: Zone | undefined,
): SensorSource[] {
  if (!zone?.rulesConfig) return [];
  try {
    return findControllingSources(zone.rulesConfig);
  } catch {
    return [];
  }
}

function isSameHistoryZones(
  first: readonly HistoryZone[],
  second: readonly HistoryZone[],
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

interface NamedSource {
  name: string;
  sourceState: Signal<SourceState>;
}

@Component({
  selector: 'temp-zones-page',
  imports: [
    MatCardModule,
    RouterLink,
    DatePipe,
    DecimalPipe,
    Pinboard,
    ZoneHistoryPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-status" aria-live="polite">
      @if (isFollower()) {
        <p class="follower">{{ followerNotice }}.</p>
      }
      @if (failedSources().length > 0) {
        <p class="alert">
          Could not load the {{ failedSources().join(', ') }}.
        </p>
      } @else if (isLoading()) {
        <p class="muted">Loading zones…</p>
      } @else if (outOfDateSources().length > 0) {
        <p class="alert">
          Could not refresh the {{ outOfDateSources().join(', ') }}; what
          follows may be out of date.
        </p>
      } @else if (cards().length === 0) {
        <p>No zones yet.</p>
      }
    </div>

    <temp-pinboard
      [items]="cards()"
      [identify]="identifyZoneCard"
      [nameOf]="nameZoneCard"
      [columnMinimumRem]="zoneColumnMinimumRem"
      [columnMaximumRem]="zoneColumnMaximumRem"
      [isArranging]="cardArrangement.isArranging()"
      (reordered)="cardArrangement.save($event)"
    >
      <ng-template let-zone>
        <mat-card
          appearance="outlined"
          class="zone"
          [class.zone--failing]="zone.failure"
        >
          <mat-card-header>
            <h2 mat-card-title class="zone__name">{{ zone.name }}</h2>
            <mat-card-subtitle>{{
              describeZoneSubtitle(zone, isFollower())
            }}</mat-card-subtitle>
          </mat-card-header>

          <mat-card-content>
            @if (zone.failure) {
              <p class="alert" role="alert">
                <strong>Not being evaluated.</strong> {{ zone.failure }}
              </p>
            } @else if (zone.isRulesRunOld) {
              <p class="alert" role="alert">
                <strong>Rules have not run for over a minute.</strong>
                What follows may no longer be true.
              </p>
            }
            @for (problem of zone.problems; track $index) {
              <p class="alert">{{ problem }}</p>
            }

            <section class="probes" aria-label="Probes">
              <p class="policy">{{ zone.policy }}</p>
              <ul>
                @for (probe of zone.probes; track probe.key) {
                  <li
                    class="probe"
                    [class.probe--controlling]="probe.tag"
                    [class.probe--quiet]="probe.isQuiet"
                  >
                    <span class="probe__name">{{ probe.label }}</span>
                    <span
                      class="probe__value"
                      [class.probe__value--deciding]="
                        probe.isTemperatureDeciding
                      "
                      >{{ probe.temperatureC | number: '1.1-1' }} °C</span
                    >
                    @if (probe.co2Ppm !== null) {
                      <span
                        class="probe__value"
                        [class.probe__value--deciding]="probe.isCo2Deciding"
                        >{{ probe.co2Ppm | number: '1.0-0' }} ppm CO₂</span
                      >
                    }
                    <span class="probe__age">
                      @if (probe.isQuiet) {
                        quiet {{ formatDuration(probe.ageSeconds) }}
                      } @else {
                        {{ formatDuration(probe.ageSeconds) }} ago
                      }
                    </span>
                    @if (probe.tag) {
                      <span class="probe__tag">{{ probe.tag }}</span>
                    }
                  </li>
                } @empty {
                  <li class="muted">No probes reporting in this zone.</li>
                }
              </ul>
            </section>

            @if (historyCharts().get(zone.id); as chart) {
              <temp-zone-history-panel [chart]="chart" />
            } @else if (historyState() === 'failed') {
              <p class="alert history-failed">
                Could not load the last 24 hours.
              </p>
            }

            @if (zone.daylight; as daylight) {
              <section class="daylight" aria-label="Daylight window">
                <div
                  class="strip"
                  role="img"
                  [attr.aria-label]="daylight.screenReaderText"
                >
                  @for (segment of daylight.segments; track $index) {
                    <span
                      class="strip__day"
                      [style.left.%]="segment.fromPercent"
                      [style.width.%]="segment.widthPercent"
                    ></span>
                  }
                  @if (daylight.nowPercent !== null) {
                    <span
                      class="strip__now"
                      [style.left.%]="daylight.nowPercent"
                    ></span>
                  }
                </div>
                <div class="strip__labels">
                  <span>00:00</span>
                  <span>day {{ daylight.windowLabel }}</span>
                  <span>24:00</span>
                </div>
              </section>
            }

            @for (rule of zone.rules; track rule.role) {
              <section
                class="rule"
                [class.rule--unowned]="!rule.isOwned"
                [attr.aria-label]="rule.label + ' rule'"
              >
                <header class="rule__head">
                  <h3>{{ rule.label }}</h3>
                  @if (!rule.isOwned) {
                    <span class="rule__decision tone-idle"
                      >not driven by tempestas</span
                    >
                  } @else if (rule.decision; as decision) {
                    <span
                      class="rule__decision"
                      [class]="'tone-' + decision.tone"
                      >{{ decision.headline }}</span
                    >
                  }
                </header>

                @if (rule.problem) {
                  <p class="alert">{{ rule.problem }}</p>
                }
                @for (bar of rule.bars; track bar.caption) {
                  <figure class="bar">
                    <figcaption>
                      <span>{{ bar.caption }}</span>
                      <span class="bar__now">{{ bar.readingText }}</span>
                    </figcaption>
                    <div
                      class="bar__track"
                      role="img"
                      [attr.aria-label]="bar.screenReaderText"
                    >
                      <div class="bar__segments">
                        @for (segment of bar.segments; track $index) {
                          <span
                            class="bar__segment segment-{{ segment.kind }}"
                            [style.left.%]="segment.fromPercent"
                            [style.width.%]="segment.widthPercent"
                          ></span>
                        }
                      </div>
                      @if (bar.marker; as marker) {
                        @if (marker.offScale) {
                          <span
                            class="bar__offscale bar__offscale--{{
                              marker.offScale
                            }}"
                            [class.bar__offscale--stale]="marker.isStale"
                            aria-hidden="true"
                            >{{ marker.offScale === 'high' ? '▶' : '◀' }}</span
                          >
                        } @else {
                          <span
                            class="bar__marker"
                            [class.bar__marker--stale]="marker.isStale"
                            [style.left.%]="marker.atPercent"
                          ></span>
                        }
                      }
                    </div>
                    <div class="bar__labels" aria-hidden="true">
                      @for (label of bar.labels; track $index) {
                        <span [style.left.%]="label.atPercent">{{
                          label.text
                        }}</span>
                      }
                    </div>
                  </figure>
                }
                @for (note of rule.notes; track $index) {
                  <p class="note">{{ note }}</p>
                }
                @if (rule.stalePolicy) {
                  <p class="note">{{ rule.stalePolicy }}</p>
                }

                @if (rule.devices.length > 0) {
                  <ul class="devices" aria-label="Devices">
                    @for (device of rule.devices; track device.id) {
                      <li
                        class="device"
                        [class.device--on]="device.isOn"
                        [class.device--failed]="device.hasFailed"
                      >
                        <span class="device__state">{{
                          device.isOn ? 'ON' : 'off'
                        }}</span>
                        <span class="device__name">
                          <a [routerLink]="['/nodes', device.nodeId]">{{
                            device.name
                          }}</a>
                          <span class="muted">{{ device.where }}</span>
                        </span>
                        <span class="device__detail">
                          @if (device.isManual) {
                            <strong class="manual">manual</strong> ·
                          }
                          @if (device.cooldownSeconds !== null) {
                            can restart in
                            {{ formatDuration(device.cooldownSeconds) }} ·
                          }
                          {{ device.outcome ?? 'no decision yet' }}
                        </span>
                      </li>
                    }
                  </ul>
                } @else if (rule.isOwned) {
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
      </ng-template>
    </temp-pinboard>
  `,
  styles: `
    .follower {
      margin: 0 0 0.75rem;
      font-weight: 500;
    }
    .zone__name {
      margin: 0;
    }
    .zone--failing {
      border-color: var(--temp-gauge-red);
    }
    .alert {
      color: var(--temp-gauge-red);
      margin: 0 0 0.75rem;
    }
    .alert::before,
    .probe--quiet .probe__age::before {
      content: '⚠ ' / '';
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
    .probe__value--deciding {
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
    .rule__head h3 {
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
    .bar__offscale--stale {
      opacity: 0.5;
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
    .bar__segments {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      overflow: hidden;
    }
    .bar__segment {
      position: absolute;
      top: 0;
      bottom: 0;
    }
    .segment-on {
      background: color-mix(in srgb, var(--temp-gauge-orange) 55%, transparent);
    }
    .segment-band {
      background: repeating-linear-gradient(
        135deg,
        var(--mat-sys-outline-variant) 0 4px,
        transparent 4px 8px
      );
    }
    .segment-off {
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
    .bar__marker--stale {
      background: transparent;
      border: 1px dashed var(--mat-sys-on-surface);
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

  private readonly zones = injectLiveSource((options) =>
    this.api.fetchZones(options),
  );
  private readonly nodes = injectLiveSource((options) =>
    this.api.nodes(options),
  );
  private readonly cycle = injectLiveRulesCycle();
  private readonly readings = injectLiveReadings();
  private readonly devices = injectLiveDevices();
  private readonly now = injectServerNow(CLOCK_TICK_MILLISECONDS);
  private readonly history = injectLiveZoneHistory();
  private readonly historyNow = injectServerNow(HISTORY_TICK_MILLISECONDS);
  protected readonly cardArrangement =
    injectCardArrangement(ZONES_CARD_ORDER_KEY);

  private readonly sources: NamedSource[] = [
    { name: 'zones', sourceState: this.zones.sourceState },
    { name: 'nodes', sourceState: this.nodes.sourceState },
    { name: 'devices', sourceState: this.devices.sourceState },
    { name: 'readings', sourceState: this.readings.sourceState },
    { name: 'rules cycle', sourceState: this.cycle.sourceState },
  ];

  protected readonly formatDuration = formatDuration;

  protected readonly describeZoneSubtitle = describeZoneSubtitle;

  protected readonly followerNotice = FOLLOWER_NOTICE;

  protected readonly isFollower = computed(() =>
    isFollowing(this.realtime.status()),
  );

  protected readonly failedSources = computed(() =>
    this.nameSourcesIn('failed'),
  );

  protected readonly outOfDateSources = computed(() =>
    this.nameSourcesIn('out-of-date'),
  );

  protected readonly isLoading = computed(
    () => this.nameSourcesIn('loading').length > 0,
  );

  protected readonly zoneColumnMinimumRem = ZONE_COLUMN_MINIMUM_REM;
  protected readonly zoneColumnMaximumRem = ZONE_COLUMN_MAXIMUM_REM;
  protected readonly identifyZoneCard = identifyZoneCard;
  protected readonly nameZoneCard = nameZoneCard;

  readonly cards = computed(() => {
    const hasEverySource =
      !this.isLoading() && this.failedSources().length === 0;
    if (!hasEverySource) return [];
    return this.cardArrangement.arrange(
      buildZoneCards({
        zones: this.zones.latest()?.payload ?? [],
        cycle: this.cycle.cycle(),
        nodes: this.nodes.latest()?.payload ?? [],
        readings: this.readings.readings(),
        devices: this.devices.devices(),
        now: this.now(),
      }),
      identifyZoneCard,
    );
  });

  protected readonly historyState = this.history.sourceState;

  private readonly historyZones = computed(
    () => {
      const zonesById = new Map(
        (this.zones.latest()?.payload ?? []).map((zone) => [zone.id, zone]),
      );
      return this.cards().map((card) =>
        toHistoryZone(card, zonesById.get(card.id)),
      );
    },
    { equal: isSameHistoryZones },
  );

  private readonly zoneIdByNodeSlug = computed(
    () =>
      new Map(
        (this.nodes.latest()?.payload ?? []).flatMap((node) =>
          node.zoneId ? [[node.slug, node.zoneId] as const] : [],
        ),
      ),
  );

  protected readonly historyCharts = computed(
    (): Map<string, ZoneHistoryChart> => {
      const report = this.history.report();
      if (!report) return new Map();
      return buildZoneHistoryCharts({
        report,
        zones: this.historyZones(),
        pushedReadings: this.history.pushedReadings(),
        zoneIdByNodeSlug: this.zoneIdByNodeSlug(),
        pushedDevices: [...this.realtime.devicePushes().values()].map(
          (push) => push.device,
        ),
        now: this.historyNow(),
      });
    },
  );

  private nameSourcesIn(state: SourceState): string[] {
    return this.sources
      .filter((source) => source.sourceState() === state)
      .map((source) => source.name);
  }
}
