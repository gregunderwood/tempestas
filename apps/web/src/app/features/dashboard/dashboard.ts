import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { injectLiveDevices } from '../../core/live-devices';
import { injectLiveReadings } from '../../core/live-readings';
import { Gauge } from '../../shared/gauge/gauge';
import { metricsFor } from '../../shared/metrics';
import {
  READING_QUIET_AFTER_SECONDS,
  secondsSince,
} from '../../shared/freshness';
import {
  sensorKey,
  type Device,
  type MetricKey,
  type Node,
  type Reading,
} from '@tempestas/domain';

interface SensorGauge {
  key: string;
  metric: MetricKey;
  value: number | null;
  /** Only set when the node has several sensors - otherwise it is noise. */
  caption: string | null;
}

interface NodeCard {
  nodeId: string;
  /** The newest reading of any sensor on the node, for the subtitle. */
  latestAt: string;
  gauges: SensorGauge[];
  /** Sensors that have stopped reporting, with how long ago. */
  quiet: { sensorId: string; ageSeconds: number }[];
  stale: boolean;
  severalSensors: boolean;
  devices: Device[];
}

/**
 * What the greenhouse is doing right now, on one screen.
 *
 * Two things here are safety features rather than presentation, and both come
 * from docs/Safety.md:
 *
 * A reading that has stopped arriving is marked on the card. The banner in the
 * shell covers the case where an OWNED ROLE goes stale, but a node can go quiet
 * without that firing, and a dashboard showing a confident number with no
 * indication of its age is how somebody trusts a value from an hour ago.
 *
 * A relay that is energised says so in words, not only in colour. This screen
 * is read in sunlight on a phone.
 */
@Component({
  selector: 'temp-dashboard',
  imports: [MatCardModule, RouterLink, DatePipe, Gauge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Dashboard</h1>

    @if (cards().length === 0) {
      <mat-card appearance="outlined">
        <mat-card-content>
          <p>No readings yet.</p>
          <p class="muted">
            Nodes appear here once they are admitted and start publishing.
          </p>
        </mat-card-content>
      </mat-card>
    }

    <div class="cards">
      @for (card of cards(); track card.nodeId) {
        <mat-card appearance="outlined" [class.card--stale]="card.stale">
          <mat-card-header>
            <mat-card-title>
              <a [routerLink]="['/nodes', card.nodeId]">{{ card.nodeId }}</a>
            </mat-card-title>
            <mat-card-subtitle>
              @if (card.stale) {
                @for (q of card.quiet; track q.sensorId) {
                  <span class="stale">
                    <span aria-hidden="true">&#9888;</span>
                    @if (card.severalSensors) {
                      {{ q.sensorId }}:
                    }
                    no reading for {{ q.ageSeconds }}s
                  </span>
                }
              } @else {
                {{ card.latestAt | date: 'shortTime' }}
              }
            </mat-card-subtitle>
          </mat-card-header>

          <mat-card-content>
            <div class="gauges">
              @for (g of card.gauges; track g.key) {
                <div class="gauge">
                  <temp-gauge [metricKey]="g.metric" [value]="g.value" />
                  @if (g.caption) {
                    <span class="gauge__sensor">{{ g.caption }}</span>
                  }
                </div>
              }
            </div>

            @if (card.devices.length > 0) {
              <ul class="relays" aria-label="Relays on this node">
                @for (device of card.devices; track device.id) {
                  <li class="relay" [class.relay--on]="device.isOn">
                    <span>{{ device.name }}</span>
                    <!-- Stated in words: colour alone is not readable in
                         sunlight, and this one means a burner is alight. -->
                    <span class="relay__state">{{
                      device.isOn ? 'ON' : 'off'
                    }}</span>
                  </li>
                }
              </ul>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: `
    .cards {
      display: grid;
      /* auto-FILL with a capped track, not auto-fit with 1fr: a single node
         would otherwise stretch one card the full width of the page and leave
         three small gauges marooned in it. */
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 23rem), 30rem));
      justify-content: start;
      gap: 1rem;
      align-items: start;
    }
    .gauges {
      display: grid;
      /* Three across wherever they fit: the three metrics are read together,
         and a 2 + 1 wrap makes the odd one look like a different kind of thing. */
      grid-template-columns: repeat(3, 1fr);
      gap: 0.25rem;
      margin-bottom: 0.75rem;
    }
    .gauge {
      margin: 0;
    }
    .gauge__sensor {
      display: block;
      text-align: center;
      font-size: 0.8rem;
      opacity: 0.7;
    }
    .stale + .stale {
      margin-left: 0.75rem;
    }
    .muted {
      opacity: 0.7;
    }
    mat-card-title a {
      color: inherit;
      text-decoration-color: var(--mat-sys-outline);
      text-underline-offset: 4px;
    }
    .card--stale {
      border-color: var(--temp-gauge-orange);
    }
    .stale {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      color: var(--temp-gauge-orange);
      font-weight: 500;
    }
    .relays {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .relay {
      display: inline-flex;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.3rem 0.7rem;
      border-radius: 999px;
      border: 1px solid var(--mat-sys-outline-variant);
      font-size: 0.9rem;
    }
    .relay__state {
      font-weight: 700;
      letter-spacing: 0.06em;
      opacity: 0.7;
    }
    .relay--on {
      border-color: var(--temp-gauge-orange);
      background: color-mix(in srgb, var(--temp-gauge-orange) 16%, transparent);
    }
    .relay--on .relay__state {
      color: var(--temp-gauge-orange);
      opacity: 1;
    }
  `,
})
export class Dashboard {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly nodes = signal<Node[]>([]);
  /** Re-read on every socket tick so ages advance without a poll of our own. */
  private readonly tick = signal(0);

  private readonly readings = injectLiveReadings();
  private readonly devices = injectLiveDevices().devices;

  readonly cards = computed<NodeCard[]>(() => {
    this.tick();
    const now = Date.now();
    const devices = this.devices();
    const nodes = new Map(this.nodes().map((node) => [node.slug, node]));

    const byNode = new Map<string, Reading[]>();
    for (const reading of this.readings()) {
      byNode.set(reading.nodeId, [
        ...(byNode.get(reading.nodeId) ?? []),
        reading,
      ]);
    }

    return [...byNode.entries()]
      .map(([nodeId, readings]) => {
        const sorted = [...readings].sort((first, second) =>
          first.sensorId.localeCompare(second.sensorId),
        );
        const several = sorted.length > 1;
        const gauges = sorted.flatMap((reading) =>
          metricsFor(reading, nodes.get(nodeId)).map((metric) => ({
            key: `${sensorKey(reading)}:${metric}`,
            metric,
            value: reading[metric],
            caption: several ? reading.sensorId : null,
          })),
        );
        const quiet = sorted
          .map((reading) => ({
            sensorId: reading.sensorId,
            ageSeconds: secondsSince(reading.createdAt, now),
          }))
          .filter(
            (quietSensor) =>
              quietSensor.ageSeconds > READING_QUIET_AFTER_SECONDS,
          );
        const latestAt = sorted
          .map((reading) => reading.createdAt)
          .reduce((latest, candidate) =>
            Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
          );
        return {
          nodeId,
          latestAt,
          gauges,
          quiet,
          stale: quiet.length > 0,
          severalSensors: several,
          devices: devices.filter((device) => device.nodeId === nodeId),
        };
      })
      .sort((first, second) => first.nodeId.localeCompare(second.nodeId));
  });

  constructor() {
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));

    // An age that never advances is worse than no age at all: the card would
    // keep claiming a reading is fresh long after the node went quiet.
    const timer = setInterval(
      () => this.tick.update((count) => count + 1),
      10_000,
    );
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}
