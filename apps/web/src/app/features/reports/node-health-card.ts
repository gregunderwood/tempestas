import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import { NODE_HEALTH_GAP_MINUTES, type NodeHealth } from '@tempestas/domain';
import {
  buildHealthEventRows,
  describeEventCounts,
  describeReadingCoverage,
  describeTimeWithoutReadings,
} from './node-health-rows';
import { HealthEventTable } from './health-event-table';

const RECENT_EVENT_COUNT = 7;

@Component({
  selector: 'temp-node-health-card',
  imports: [MatCardModule, HealthEventTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>{{ node().nodeName }}</mat-card-title>
        <mat-card-subtitle>{{ subtitle() }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        <p class="health-summary">{{ eventCounts() }}</p>
        @if (readingCoverage(); as coverage) {
          <p class="health-coverage">{{ coverage }}</p>
        }
        @if (recentRows().length > 0) {
          <temp-health-event-table [rows]="recentRows()" />
        }
        @if (earlierRows().length > 0) {
          <details>
            <summary>Earlier</summary>
            <temp-health-event-table [rows]="earlierRows()" />
          </details>
        }
        <p class="health-legend">
          A gap is over {{ gapMinutes }} minutes without a reading. Times are
          {{ node().timezone }}.
        </p>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .health-summary {
      font-size: 0.9rem;
    }
    .health-coverage,
    .health-legend {
      font-size: 0.8rem;
      opacity: 0.7;
    }
    details {
      margin-top: 0.5rem;
    }
  `,
})
export class NodeHealthCard {
  readonly node = input.required<NodeHealth>();
  readonly days = input.required<number>();
  readonly generatedAt = input.required<string>();

  protected readonly gapMinutes = NODE_HEALTH_GAP_MINUTES;
  protected readonly subtitle = computed(() => {
    const node = this.node();
    const slugUnlessName = node.nodeId === node.nodeName ? null : node.nodeId;
    return [slugUnlessName, describeTimeWithoutReadings(node)]
      .filter(Boolean)
      .join(' · ');
  });
  protected readonly eventCounts = computed(() =>
    describeEventCounts(this.node(), this.days()),
  );
  protected readonly readingCoverage = computed(() =>
    describeReadingCoverage(this.node(), {
      days: this.days(),
      generatedAt: this.generatedAt(),
    }),
  );
  private readonly rows = computed(() => buildHealthEventRows(this.node()));
  protected readonly recentRows = computed(() =>
    this.rows().slice(0, RECENT_EVENT_COUNT),
  );
  protected readonly earlierRows = computed(() =>
    this.rows().slice(RECENT_EVENT_COUNT),
  );
}
