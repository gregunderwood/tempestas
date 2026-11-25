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
import { injectLiveSource, type LiveSource } from '../../core/live-source';
import { RealtimeService } from '../../core/realtime.service';
import { openBrowserStorage } from '../../shared/arrange/card-order';
import { EquipmentRuntimeCard } from './equipment-runtime-card';
import { FreezeMarginCard } from './freeze-margin-card';
import {
  labelPropaneUnit,
  PROPANE_UNITS,
  readSavedPropaneUnit,
  writeSavedPropaneUnit,
  type PropaneUnit,
} from './propane-units';
import { ReportLoadStatus } from './report-load-status';
import {
  findReadingDueARefresh,
  FREEZE_MARGIN_REFRESH_MILLISECONDS,
  TIME_IN_RANGE_REFRESH_MILLISECONDS,
  type ZoneReadingsReport,
} from './report-refresh';
import { TimeInRangeCard } from './time-in-range-card';

const UPCOMING_REPORTS: readonly string[] = ['CO2 enrichment', 'Node health'];

@Component({
  selector: 'temp-reports-page',
  imports: [
    MatButtonToggleModule,
    MatCardModule,
    EquipmentRuntimeCard,
    FreezeMarginCard,
    ReportLoadStatus,
    TimeInRangeCard,
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
    <section aria-labelledby="time-in-range-heading" class="temp-time-in-range">
      <h2 id="time-in-range-heading">Time in range</h2>
      <p class="temp-muted">
        Hours each day and each night spent where the zone's rules are set to
        hold it: below a heat rule's on-setpoint, above the fan's, or between,
        with the night's low and the day's high.
      </p>
      <temp-report-load-status
        [state]="timeInRangeState()"
        subject="time in range"
      />
      @if (
        timeInRangeState() !== 'loading' && timeInRangeZones().length === 0
      ) {
        <p class="temp-muted">No zone has a node yet.</p>
      }
      <div class="temp-card-grid temp-time-in-range-cards">
        @for (zone of timeInRangeZones(); track zone.zoneId) {
          <temp-time-in-range-card [zone]="zone" />
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
    .temp-freeze-margin-cards,
    .temp-time-in-range-cards {
      --temp-card-min-width: 40rem;
    }
    .temp-freeze-margin,
    .temp-time-in-range,
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
  private readonly timeInRangeSource = injectLiveSource((options) =>
    this.api.fetchTimeInRange({}, options),
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

  protected readonly timeInRangeState = this.timeInRangeSource.sourceState;
  protected readonly timeInRangeZones = computed(
    () => this.timeInRangeSource.latest()?.payload.zones ?? [],
  );

  protected readonly hasPropaneEstimate = computed(() =>
    this.runtimeDevices().some((device) => device.totalPropaneLitres !== null),
  );

  constructor() {
    this.refreshWhenADeviceSwitchesOrANodeComesAndGoes();
    this.refreshAsReadingsArrive(
      this.freezeMarginSource,
      FREEZE_MARGIN_REFRESH_MILLISECONDS,
    );
    this.refreshAsReadingsArrive(
      this.timeInRangeSource,
      TIME_IN_RANGE_REFRESH_MILLISECONDS,
    );
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

  // The running period moves with every reading, with nothing switching.
  private refreshAsReadingsArrive(
    source: LiveSource<ZoneReadingsReport>,
    refreshMilliseconds: number,
  ): void {
    let refreshedForReadingAtMs = 0;
    effect(() => {
      const report = source.latest()?.payload;
      if (!report) return;
      const dueReadingMs = findReadingDueARefresh(
        report,
        Object.values(this.realtime.readings()),
        refreshedForReadingAtMs,
        refreshMilliseconds,
      );
      if (dueReadingMs === null) return;
      refreshedForReadingAtMs = dueReadingMs;
      untracked(() => source.refresh());
    });
  }
}
