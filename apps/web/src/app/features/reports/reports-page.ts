import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { ApiService } from '../../core/api.service';
import { injectLiveSource } from '../../core/live-source';
import { RealtimeService } from '../../core/realtime.service';
import { EquipmentRuntimeCard } from './equipment-runtime-card';

const UPCOMING_REPORTS: readonly string[] = [
  'Time in range',
  'Freeze margin',
  'CO2 enrichment',
  'Node health',
];

@Component({
  selector: 'temp-reports-page',
  imports: [MatCardModule, EquipmentRuntimeCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="equipment-runtime-heading">
      <h2 id="equipment-runtime-heading">Equipment runtime</h2>
      <p class="temp-muted">
        Hours on, starts and the shortest run, per device per day. Many starts
        or very short runs mean short-cycling.
      </p>
      <div aria-live="polite">
        @switch (runtimeState()) {
          @case ('loading') {
            <p class="temp-muted">Loading equipment runtime…</p>
          }
          @case ('failed') {
            <p class="temp-alert">Could not load the equipment runtime.</p>
          }
          @case ('out-of-date') {
            <p class="temp-alert">
              Could not refresh the equipment runtime; the figures below may be
              out of date.
            </p>
          }
        }
      </div>
      @if (runtimeState() !== 'loading' && runtimeDevices().length === 0) {
        <p class="temp-muted">No devices yet.</p>
      }
      <div class="temp-runtime-cards">
        @for (device of runtimeDevices(); track device.deviceId) {
          <temp-equipment-runtime-card [device]="device" />
        }
      </div>
    </section>
    <mat-card appearance="outlined" class="temp-upcoming">
      <mat-card-content>
        <p>Still to come:</p>
        <ul class="temp-upcoming-reports">
          @for (report of upcomingReports; track report) {
            <li>{{ report }}</li>
          }
        </ul>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    h2 {
      margin: 0 0 0.25rem;
    }
    .temp-runtime-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr));
      gap: 1rem;
    }
    .temp-upcoming {
      margin-top: 1.5rem;
    }
    .temp-upcoming-reports {
      margin: 0;
      padding-left: 1.25rem;
    }
    .temp-alert {
      color: var(--temp-gauge-red);
    }
    .temp-muted {
      opacity: 0.7;
      font-size: 0.85rem;
    }
  `,
})
export class ReportsPage {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly runtimeSource = injectLiveSource((options) =>
    this.api.fetchEquipmentRuntime({}, options),
  );

  readonly upcomingReports = UPCOMING_REPORTS;
  protected readonly runtimeState = this.runtimeSource.sourceState;
  protected readonly runtimeDevices = computed(
    () => this.runtimeSource.latest()?.payload.devices ?? [],
  );

  constructor() {
    this.refreshWhenADeviceSwitchesOrANodeComesAndGoes();
  }

  private refreshWhenADeviceSwitchesOrANodeComesAndGoes(): void {
    const devicePushesAtStart = this.realtime.devicePushes();
    const nodePushesAtStart = this.realtime.nodePushes();
    effect(() => {
      const hasDevicePush =
        this.realtime.devicePushes() !== devicePushesAtStart;
      const hasNodePush = this.realtime.nodePushes() !== nodePushesAtStart;
      if (!hasDevicePush && !hasNodePush) return;
      untracked(() => this.runtimeSource.refresh());
    });
  }
}
