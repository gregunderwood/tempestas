import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { DeviceRuntime } from '@tempestas/domain';
import { labelRole } from '../zones/zone-words';
import {
  DEFAULT_PROPANE_UNIT,
  formatPropane,
  type PropaneUnit,
} from './propane-units';
import {
  buildTrendBars,
  countDaysWithCappedRun,
  findShortestRunMinutes,
  formatHours,
  formatMinutes,
  listDaysSinceAdded,
  TREND_BAR_PITCH,
  TREND_HEIGHT,
} from './runtime-trend';

@Component({
  selector: 'temp-equipment-runtime-card',
  imports: [MatCardModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined" class="runtime-card">
      <mat-card-header>
        <mat-card-title>{{ device().deviceName }}</mat-card-title>
        <mat-card-subtitle>{{ subtitle() }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <dl class="runtime-totals">
          <div>
            <dt>Hours on</dt>
            <dd>{{ formatHours(device().totalHoursOn) }}</dd>
          </div>
          <div>
            <dt>Starts</dt>
            <dd>{{ device().totalStarts }}</dd>
          </div>
          <div>
            <dt>Shortest run</dt>
            <dd>{{ shortestRun() }}</dd>
          </div>
          <div>
            <dt>Unknown</dt>
            <dd>{{ formatHours(device().totalHoursUnknown) }}</dd>
          </div>
          @if (hasPropaneEstimate()) {
            <div>
              <dt>Propane</dt>
              <dd class="runtime-propane">
                {{ formatPropane(device().totalPropaneLitres, propaneUnit()) }}
              </dd>
            </div>
          }
        </dl>
        @if (propaneNote(); as note) {
          <p class="runtime-propane-note">{{ note }}</p>
        }
        @if (daysWithCappedRun() > 0) {
          <p class="runtime-capped">
            The node went offline mid-run on {{ daysWithCappedRun() }}
            {{ daysWithCappedRun() === 1 ? 'day' : 'days' }}; those runs are
            counted only to when it was last seen.
          </p>
        }
        <svg
          class="runtime-trend"
          role="img"
          [attr.viewBox]="viewBox()"
          preserveAspectRatio="none"
          [attr.aria-label]="'Hours on per day for ' + device().deviceName"
        >
          @for (bar of bars(); track bar.date) {
            <g>
              <title>{{ bar.description }}</title>
              <rect
                class="runtime-trend__unknown"
                [attr.x]="bar.x"
                [attr.y]="bar.unknownY"
                [attr.width]="bar.width"
                [attr.height]="bar.unknownHeight"
              />
              <rect
                class="runtime-trend__on"
                [class.runtime-trend__on--capped]="bar.hasRunCappedAtLastSeen"
                [attr.x]="bar.x"
                [attr.y]="bar.onY"
                [attr.width]="bar.width"
                [attr.height]="bar.onHeight"
              />
            </g>
          }
        </svg>
        <p class="runtime-legend">
          <span class="runtime-legend__on">on</span>
          <span class="runtime-legend__unknown">unknown</span>
          · {{ daysSinceAdded().length }}
          {{ daysSinceAdded().length === 1 ? 'day' : 'days' }} to today,
          {{ device().timezone }}
        </p>
        <details>
          <summary>Day by day</summary>
          <table class="runtime-days">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">On</th>
                <th scope="col">Starts</th>
                <th scope="col">Shortest</th>
                <th scope="col">Unknown</th>
                @if (hasPropaneEstimate()) {
                  <th scope="col">Propane</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (day of newestFirst(); track day.date) {
                <tr>
                  <th scope="row">
                    {{ day.date }}{{ day.hasRunCappedAtLastSeen ? ' *' : '' }}
                  </th>
                  <td>{{ formatHours(day.hoursOn) }}</td>
                  <td>{{ day.starts }}</td>
                  <td>
                    {{
                      day.shortestRunMinutes === null
                        ? '—'
                        : formatMinutes(day.shortestRunMinutes)
                    }}
                  </td>
                  <td>{{ formatHours(day.hoursUnknown) }}</td>
                  @if (hasPropaneEstimate()) {
                    <td>
                      {{ formatPropane(day.propaneLitres, propaneUnit()) }}
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </details>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .runtime-totals {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
      gap: 0.5rem;
      margin: 0 0 0.75rem;
    }
    .runtime-totals dt {
      font-size: 0.8rem;
      opacity: 0.7;
    }
    .runtime-totals dd {
      margin: 0;
      font-size: 1.1rem;
      font-variant-numeric: tabular-nums;
    }
    .runtime-propane-note {
      font-size: 0.8rem;
      opacity: 0.7;
    }
    .runtime-capped {
      color: var(--temp-gauge-orange);
      font-size: 0.85rem;
    }
    .runtime-trend {
      display: block;
      width: 100%;
      height: 4rem;
    }
    .runtime-trend__on {
      fill: var(--temp-gauge-blue);
    }
    .runtime-trend__on--capped {
      fill: var(--temp-gauge-orange);
    }
    .runtime-trend__unknown {
      fill: currentColor;
      opacity: 0.2;
    }
    .runtime-legend {
      font-size: 0.8rem;
      opacity: 0.7;
    }
    .runtime-legend__on::before,
    .runtime-legend__unknown::before {
      content: '';
      display: inline-block;
      width: 0.6rem;
      height: 0.6rem;
      margin: 0 0.25rem 0 0.5rem;
    }
    .runtime-legend__on::before {
      background: var(--temp-gauge-blue);
    }
    .runtime-legend__unknown::before {
      background: currentColor;
      opacity: 0.2;
    }
    .runtime-days {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
    }
    .runtime-days th,
    .runtime-days td {
      text-align: right;
      padding: 0.15rem 0.4rem;
    }
    .runtime-days th[scope='row'] {
      text-align: left;
      font-weight: normal;
    }
  `,
})
export class EquipmentRuntimeCard {
  readonly device = input.required<DeviceRuntime>();
  readonly propaneUnit = input<PropaneUnit>(DEFAULT_PROPANE_UNIT);

  protected readonly subtitle = computed(() => {
    const { role, nodeId } = this.device();
    return role === null ? nodeId : `${labelRole(role)} · ${nodeId}`;
  });
  protected readonly bars = computed(() => buildTrendBars(this.device().days));
  protected readonly viewBox = computed(
    () => `0 0 ${this.device().days.length * TREND_BAR_PITCH} ${TREND_HEIGHT}`,
  );
  protected readonly shortestRun = computed(() => {
    const minutes = findShortestRunMinutes(this.device().days);
    return minutes === null ? '—' : formatMinutes(minutes);
  });
  protected readonly daysWithCappedRun = computed(() =>
    countDaysWithCappedRun(this.device().days),
  );
  protected readonly daysSinceAdded = computed(() =>
    listDaysSinceAdded(this.device().days),
  );
  protected readonly newestFirst = computed(() =>
    [...this.daysSinceAdded()].reverse(),
  );
  protected readonly hasPropaneEstimate = computed(
    () => this.device().totalPropaneLitres !== null,
  );
  protected readonly propaneNote = computed(() =>
    describePropaneEstimate(this.device()),
  );
  protected readonly formatPropane = formatPropane;
  protected readonly formatHours = formatHours;
  protected readonly formatMinutes = formatMinutes;
}

function describePropaneEstimate(device: DeviceRuntime): string | null {
  if (device.inputBtuPerHour === null) return null;
  const rating = device.inputBtuPerHour.toLocaleString('en-US');
  const estimate = `Propane is estimated at the burner's ${rating} BTU/hr rating, from known hours on only`;
  return device.totalHoursUnknown > 0
    ? `${estimate}; unknown hours are not estimated.`
    : `${estimate}.`;
}
