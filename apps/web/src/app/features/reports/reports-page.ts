import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { ApiService } from '../../core/api.service';
import { injectLiveSource } from '../../core/live-source';
import { RealtimeService } from '../../core/realtime.service';
import { openBrowserStorage } from '../../shared/arrange/card-order';
import { EquipmentRuntimeCard } from './equipment-runtime-card';
import { FreezeMarginCard } from './freeze-margin-card';
import { findReadingDueARefresh } from './freeze-margin-refresh';
import { NodeHealthCard } from './node-health-card';
import {
  labelPropaneUnit,
  PROPANE_UNITS,
  readSavedPropaneUnit,
  writeSavedPropaneUnit,
  type PropaneUnit,
} from './propane-units';
import { ReportLoadStatus } from './report-load-status';

const UPCOMING_REPORTS: readonly string[] = ['Time in range', 'CO2 enrichment'];

@Component({
  selector: 'temp-reports-page',
  imports: [
    MatButtonToggleModule,
    MatCardModule,
    EquipmentRuntimeCard,
    FreezeMarginCard,
    NodeHealthCard,
    ReportLoadStatus,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section aria-labelledby="equipment-runtime-heading">
      <h2 id="equipment-runtime-heading">Equipment runtime</h2>
      <p class="temp-muted">
        Hours on, starts and the shortest run, per device per day. Many starts
        or very short runs mean short-cycling.
      </p>
      @if (hasPropaneEstimate()) {
        <mat-button-toggle-group
          class="temp-propane-unit"
          aria-label="Propane unit"
          hideSingleSelectionIndicator
          [value]="propaneUnit()"
          (change)="choosePropaneUnit($event.value)"
        >
          @for (unit of propaneUnits; track unit) {
            <mat-button-toggle [value]="unit">{{
              labelPropaneUnit(unit)
            }}</mat-button-toggle>
          }
        </mat-button-toggle-group>
      }
      <temp-report-load-status
        [state]="runtimeState()"
        subject="equipment runtime"
      />
      @if (runtimeState() !== 'loading' && runtimeDevices().length === 0) {
        <p class="temp-muted">No devices yet.</p>
      }
      <div class="temp-card-grid temp-runtime-cards">
        @for (device of runtimeDevices(); track device.deviceId) {
          <temp-equipment-runtime-card
            [device]="device"
            [propaneUnit]="propaneUnit()"
          />
        }
      </div>
    </section>
    <section aria-labelledby="freeze-margin-heading" class="temp-freeze-margin">
      <h2 id="freeze-margin-heading">Freeze margin</h2>
      <p class="temp-muted">
        Each night's coldest reading, whether the heat was on at that moment,
        and the hours below the warning, for every zone with a heater or heat
        tape.
      </p>
      <temp-report-load-status
        [state]="freezeMarginState()"
        subject="freeze margin"
      />
      @if (
        freezeMarginState() !== 'loading' && freezeMarginZones().length === 0
      ) {
        <p class="temp-muted">No zone has a heater or heat tape yet.</p>
      }
      <div class="temp-card-grid temp-freeze-margin-cards">
        @for (zone of freezeMarginZones(); track zone.zoneId) {
          <temp-freeze-margin-card [zone]="zone" />
        }
      </div>
    </section>
    <section aria-labelledby="node-health-heading" class="temp-node-health">
      <h2 id="node-health-heading">Node health</h2>
      <p class="temp-muted">
        Per node: gaps in its readings, reboots, and agent updates run from the
        Nodes page. Times the rules held a device because its sensors were stale
        are not recorded yet, so they cannot be listed here.
      </p>
      <temp-report-load-status
        [state]="nodeHealthState()"
        subject="node health"
      />
      @if (nodeHealthReport(); as report) {
        @if (report.nodes.length === 0) {
          <p class="temp-muted">No admitted nodes yet.</p>
        }
        <div class="temp-card-grid temp-node-health-cards">
          @for (node of report.nodes; track node.nodeId) {
            <temp-node-health-card
              [node]="node"
              [days]="report.days"
              [generatedAt]="report.generatedAt"
            />
          }
        </div>
      }
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
    .temp-propane-unit {
      margin-bottom: 1rem;
    }
    .temp-card-grid {
      display: grid;
      grid-template-columns: repeat(
        auto-fill,
        minmax(min(100%, var(--temp-card-min-width)), 1fr)
      );
      gap: 1rem;
    }
    .temp-runtime-cards {
      --temp-card-min-width: 22rem;
    }
    .temp-freeze-margin-cards {
      --temp-card-min-width: 40rem;
    }
    .temp-node-health-cards {
      --temp-card-min-width: 22rem;
    }
    .temp-freeze-margin,
    .temp-node-health,
    .temp-upcoming {
      margin-top: 1.5rem;
    }
    .temp-upcoming-reports {
      margin: 0;
      padding-left: 1.25rem;
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
  private readonly freezeMarginSource = injectLiveSource((options) =>
    this.api.fetchFreezeMargin({}, options),
  );
  private readonly nodeHealthSource = injectLiveSource((options) =>
    this.api.fetchNodeHealth({}, options),
  );
  private readonly browserStorage = openBrowserStorage();

  readonly upcomingReports = UPCOMING_REPORTS;
  protected readonly propaneUnits = PROPANE_UNITS;
  protected readonly labelPropaneUnit = labelPropaneUnit;
  protected readonly propaneUnit = signal(
    readSavedPropaneUnit(this.browserStorage),
  );
  protected readonly runtimeState = this.runtimeSource.sourceState;
  protected readonly runtimeDevices = computed(
    () => this.runtimeSource.latest()?.payload.devices ?? [],
  );

  protected readonly freezeMarginState = this.freezeMarginSource.sourceState;
  protected readonly freezeMarginZones = computed(
    () => this.freezeMarginSource.latest()?.payload.zones ?? [],
  );

  protected readonly nodeHealthState = this.nodeHealthSource.sourceState;
  protected readonly nodeHealthReport = computed(
    () => this.nodeHealthSource.latest()?.payload ?? null,
  );

  protected readonly hasPropaneEstimate = computed(() =>
    this.runtimeDevices().some((device) => device.totalPropaneLitres !== null),
  );

  constructor() {
    this.refreshWhenADeviceSwitchesOrANodeComesAndGoes();
    this.refreshFreezeMarginAsHeatedZonesReport();
    this.refreshNodeHealthWhenANodeChanges();
  }

  protected choosePropaneUnit(unit: PropaneUnit): void {
    this.propaneUnit.set(unit);
    writeSavedPropaneUnit(this.browserStorage, unit);
  }

  private refreshWhenADeviceSwitchesOrANodeComesAndGoes(): void {
    const devicePushesAtStart = this.realtime.devicePushes();
    const nodePushesAtStart = this.realtime.nodePushes();
    effect(() => {
      const hasDevicePush =
        this.realtime.devicePushes() !== devicePushesAtStart;
      const hasNodePush = this.realtime.nodePushes() !== nodePushesAtStart;
      if (!hasDevicePush && !hasNodePush) return;
      untracked(() => {
        this.runtimeSource.refresh();
        this.freezeMarginSource.refresh();
      });
    });
  }

  // A node going quiet, coming back or rebooting announces itself, so its pushes are enough.
  private refreshNodeHealthWhenANodeChanges(): void {
    const nodePushesAtStart = this.realtime.nodePushes();
    effect(() => {
      if (this.realtime.nodePushes() === nodePushesAtStart) return;
      untracked(() => this.nodeHealthSource.refresh());
    });
  }

  // Tonight's row drifts colder without any heat switching, so readings refresh it too.
  private refreshFreezeMarginAsHeatedZonesReport(): void {
    let refreshedForReadingAtMs = 0;
    effect(() => {
      const report = this.freezeMarginSource.latest()?.payload;
      if (!report) return;
      const dueReadingMs = findReadingDueARefresh(
        report,
        Object.values(this.realtime.readings()),
        refreshedForReadingAtMs,
      );
      if (dueReadingMs === null) return;
      refreshedForReadingAtMs = dueReadingMs;
      untracked(() => this.freezeMarginSource.refresh());
    });
  }
}
