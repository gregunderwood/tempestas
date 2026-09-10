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
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import { Gauge } from '../../shared/gauge/gauge';
import type { Device, Reading } from '@tempestas/domain';

/** Beyond this a reading is old enough to say so on the card. */
const STALE_AFTER_S = 120;

interface NodeCard {
  nodeId: string;
  reading: Reading;
  ageSeconds: number;
  stale: boolean;
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
  imports: [MatCardModule, DatePipe, Gauge],
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
            <mat-card-title>{{ card.nodeId }}</mat-card-title>
            <mat-card-subtitle>
              @if (card.stale) {
                <span class="stale">
                  <span aria-hidden="true">&#9888;</span>
                  no reading for {{ card.ageSeconds }}s
                </span>
              } @else {
                {{ card.reading.createdAt | date: 'shortTime' }}
              }
            </mat-card-subtitle>
          </mat-card-header>

          <mat-card-content>
            <div class="gauges">
              <temp-gauge
                metricKey="temperature"
                [value]="card.reading.temperature"
              />
              <temp-gauge
                metricKey="humidity"
                [value]="card.reading.humidity"
              />
              <temp-gauge metricKey="co2" [value]="card.reading.co2" />
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
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 23rem), 1fr));
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
    .muted {
      opacity: 0.7;
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
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly fetchedReadings = signal<Reading[]>([]);
  private readonly fetchedDevices = signal<Device[]>([]);
  /** Re-read on every socket tick so ages advance without a poll of our own. */
  private readonly tick = signal(0);

  /** The socket patches what the API established, never replaces it. */
  private readonly readings = computed<Reading[]>(() => {
    const live = this.realtime.readings();
    const merged = new Map(this.fetchedReadings().map((r) => [r.nodeId, r]));
    for (const [nodeId, reading] of Object.entries(live)) {
      merged.set(nodeId, reading);
    }
    return [...merged.values()];
  });

  private readonly devices = computed<Device[]>(() => {
    const pushed = this.realtime.deviceState();
    const all = this.fetchedDevices();
    return pushed === null
      ? all
      : all.map((d) => (d.id === pushed.id ? pushed : d));
  });

  readonly cards = computed<NodeCard[]>(() => {
    this.tick();
    const now = Date.now();
    const devices = this.devices();
    return this.readings()
      .map((reading) => {
        const ageSeconds = Math.max(
          0,
          Math.round((now - new Date(reading.createdAt).getTime()) / 1000),
        );
        return {
          nodeId: reading.nodeId,
          reading,
          ageSeconds,
          stale: ageSeconds > STALE_AFTER_S,
          devices: devices.filter((d) => d.nodeId === reading.nodeId),
        };
      })
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  });

  constructor() {
    this.api
      .latestReadings()
      .subscribe((readings) => this.fetchedReadings.set(readings));
    this.api.devices().subscribe((devices) => this.fetchedDevices.set(devices));

    // An age that never advances is worse than no age at all: the card would
    // keep claiming a reading is fresh long after the node went quiet.
    const timer = setInterval(() => this.tick.update((n) => n + 1), 10_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}
