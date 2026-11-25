import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { HealthEventRow } from './node-health-rows';

@Component({
  selector: 'temp-health-event-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="health-events">
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">What</th>
          <th scope="col" class="health-events__length">Length</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.at + row.kind) {
          <tr [class]="'health-events__' + row.kind">
            <th scope="row">{{ row.when }}</th>
            <td>{{ row.what }}</td>
            <td class="health-events__length">{{ row.length }}</td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    .health-events {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
    }
    .health-events th,
    .health-events td {
      text-align: left;
      vertical-align: top;
      padding: 0.2rem 0.4rem;
    }
    .health-events th[scope='row'] {
      font-weight: normal;
      white-space: nowrap;
    }
    .health-events .health-events__length {
      text-align: right;
      white-space: nowrap;
    }
    .health-events__gap td {
      color: var(--temp-gauge-orange);
    }
  `,
})
export class HealthEventTable {
  readonly rows = input.required<readonly HealthEventRow[]>();
}
