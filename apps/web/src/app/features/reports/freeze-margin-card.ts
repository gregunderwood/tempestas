import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import {
  FREEZE_MARGIN_BUCKET_MINUTES,
  type ZoneFreezeMargin,
} from '@tempestas/domain';
import {
  buildNightRows,
  countNightsOfConcern,
  describeWarning,
} from './freeze-margin-rows';
import { FreezeNightTable } from './freeze-night-table';

const RECENT_NIGHT_COUNT = 7;

@Component({
  selector: 'temp-freeze-margin-card',
  imports: [MatCardModule, FreezeNightTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ zone().zoneName }}</mat-card-title>
        <mat-card-subtitle>{{ warning() }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (nightsOfConcern() > 0) {
          <p class="freeze-summary freeze-summary--concern">
            {{ nightsOfConcern() }}
            {{ nightsOfConcern() === 1 ? 'night needs' : 'nights need' }} a
            look.
          </p>
        } @else {
          <p class="freeze-summary">
            No night in the last {{ zone().nights.length }} needs a look.
          </p>
        }
        <temp-freeze-night-table
          [rows]="recentRows()"
          [warningBelowC]="zone().warningBelowC"
        />
        @if (earlierRows().length > 0) {
          <details>
            <summary>Earlier nights</summary>
            <temp-freeze-night-table
              [rows]="earlierRows()"
              [warningBelowC]="zone().warningBelowC"
            />
          </details>
        }
        <p class="freeze-legend">
          Nights are the zone's dark hours, {{ zone().timezone }}. Hours below
          count {{ bucketMinutes }}-minute stretches in which any probe read
          below the warning.
        </p>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .freeze-summary {
      font-size: 0.9rem;
    }
    .freeze-summary--concern {
      color: var(--temp-gauge-red);
      font-weight: 500;
    }
    details {
      margin-top: 0.5rem;
    }
    .freeze-legend {
      font-size: 0.8rem;
      opacity: 0.7;
    }
  `,
})
export class FreezeMarginCard {
  readonly zone = input.required<ZoneFreezeMargin>();

  protected readonly bucketMinutes = FREEZE_MARGIN_BUCKET_MINUTES;
  protected readonly warning = computed(() => describeWarning(this.zone()));
  protected readonly nightsOfConcern = computed(() =>
    countNightsOfConcern(this.zone()),
  );
  private readonly rows = computed(() => buildNightRows(this.zone()));
  protected readonly recentRows = computed(() =>
    this.rows().slice(0, RECENT_NIGHT_COUNT),
  );
  protected readonly earlierRows = computed(() =>
    this.rows().slice(RECENT_NIGHT_COUNT),
  );
}
