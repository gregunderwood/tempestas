import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import {
  TIME_IN_RANGE_BUCKET_MINUTES,
  TIME_IN_RANGE_LONGEST_HELD_MINUTES,
  type ZoneTimeInRange,
} from '@tempestas/domain';
import {
  buildPeriodRows,
  describeLowerBound,
  describeUpperBound,
  summariseShareInRange,
} from './time-in-range-rows';
import { TimeInRangeTable } from './time-in-range-table';

const RECENT_PERIOD_COUNT = 14;

@Component({
  selector: 'temp-time-in-range-card',
  imports: [MatCardModule, TimeInRangeTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ zone().zoneName }}</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        <ul class="range-bounds">
          <li>{{ lowerBound() }}</li>
          <li>{{ upperBound() }}</li>
        </ul>
        @for (line of shareInRange(); track line) {
          <p class="range-summary">{{ line }}</p>
        } @empty {
          <p class="range-summary">
            No readings in the last {{ zone().periods.length }} periods.
          </p>
        }
        <temp-time-in-range-table [rows]="recentRows()" />
        @if (earlierRows().length > 0) {
          <details>
            <summary>Earlier periods</summary>
            <temp-time-in-range-table [rows]="earlierRows()" />
          </details>
        }
        <p class="range-legend">
          Days and nights are the zone's daylight window, {{ zone().timezone }}.
          A reading counts until the next one, for at most
          {{ longestHeldMinutes }} min, judged in {{ bucketMinutes }}-minute
          stretches; the rest of the period counts as no readings.
        </p>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .range-bounds {
      margin: 0 0 0.5rem;
      padding-left: 1.25rem;
      font-size: 0.85rem;
    }
    .range-summary {
      font-size: 0.9rem;
      margin: 0 0 0.25rem;
    }
    details {
      margin-top: 0.5rem;
    }
    .range-legend {
      font-size: 0.8rem;
      opacity: 0.7;
    }
  `,
})
export class TimeInRangeCard {
  readonly zone = input.required<ZoneTimeInRange>();

  protected readonly bucketMinutes = TIME_IN_RANGE_BUCKET_MINUTES;
  protected readonly longestHeldMinutes = TIME_IN_RANGE_LONGEST_HELD_MINUTES;
  protected readonly lowerBound = computed(() =>
    describeLowerBound(this.zone()),
  );
  protected readonly upperBound = computed(() =>
    describeUpperBound(this.zone()),
  );
  protected readonly shareInRange = computed(() =>
    summariseShareInRange(this.zone()),
  );
  private readonly rows = computed(() => buildPeriodRows(this.zone()));
  protected readonly recentRows = computed(() =>
    this.rows().slice(0, RECENT_PERIOD_COUNT),
  );
  protected readonly earlierRows = computed(() =>
    this.rows().slice(RECENT_PERIOD_COUNT),
  );
}
