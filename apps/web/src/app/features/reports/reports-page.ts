import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatCardModule } from '@angular/material/card';

const UPCOMING_REPORTS: readonly string[] = [
  'Time in range',
  'Equipment runtime',
  'Freeze margin',
  'CO2 enrichment',
  'Node health',
];

@Component({
  selector: 'temp-reports-page',
  imports: [MatCardModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-content>
        <p>No reports yet. These are coming:</p>
        <ul class="temp-upcoming-reports">
          @for (report of upcomingReports; track report) {
            <li>{{ report }}</li>
          }
        </ul>
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    .temp-upcoming-reports {
      margin: 0;
      padding-left: 1.25rem;
    }
  `,
})
export class ReportsPage {
  readonly upcomingReports = UPCOMING_REPORTS;
}
