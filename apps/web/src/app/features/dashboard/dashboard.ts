import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { ApiService } from '../../core/api.service';
import { RealtimeService } from '../../core/realtime.service';
import type { Reading } from '@tempestas/domain';

/**
 * Placeholder until phase 10 brings the gauges. It reads real data through the
 * real plumbing on purpose: a shell whose screens are all `<p>TODO</p>` proves
 * nothing about whether the wiring works.
 */
@Component({
  selector: 'temp-dashboard',
  imports: [MatCardModule, DecimalPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Dashboard</h1>
    @if (readings().length === 0) {
      <p>No readings yet.</p>
    }
    <div class="temp-cards">
      @for (reading of readings(); track reading.nodeId) {
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ reading.nodeId }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <p class="temp-metric">{{ reading.temperature | number: '1.1-1' }} °C</p>
            <p>{{ reading.humidity | number: '1.0-0' }} % RH</p>
            <!-- An em-dash, never a zero: null CO2 means unknown. -->
            <p>{{ reading.co2 === null ? '—' : (reading.co2 | number: '1.0-0') }} ppm</p>
            <p class="temp-muted">{{ reading.createdAt | date: 'medium' }}</p>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: `
    .temp-cards { display: flex; flex-wrap: wrap; gap: 1rem; }
    .temp-metric { font-size: 2rem; margin: 0.25rem 0; }
    .temp-muted { opacity: 0.7; font-size: 0.85rem; }
  `,
})
export class Dashboard {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);

  private readonly fetched = signal<Reading[]>([]);

  /** The socket patches what the API established, never replaces it. */
  readonly readings = computed<Reading[]>(() => {
    const live = this.realtime.readings();
    const merged = new Map(this.fetched().map((r) => [r.nodeId, r]));
    for (const [nodeId, reading] of Object.entries(live)) {
      merged.set(nodeId, reading);
    }
    return [...merged.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  });

  constructor() {
    this.api.latestReadings().subscribe((readings) => this.fetched.set(readings));
  }
}
