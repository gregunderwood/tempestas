import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { PeriodRow } from './time-in-range-rows';

@Component({
  selector: 'temp-time-in-range-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="range-scroll">
      <table class="range-periods">
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Extreme</th>
            <th scope="col" class="range-periods__hours">Below</th>
            <th scope="col" class="range-periods__hours">In range</th>
            <th scope="col" class="range-periods__hours">Above</th>
            <th scope="col" class="range-periods__hours">No readings</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.from) {
            <tr>
              <th scope="row">{{ row.label }}</th>
              <td>{{ row.extreme }}</td>
              <td class="range-periods__hours">{{ row.below }}</td>
              <td class="range-periods__hours">{{ row.inRange }}</td>
              <td class="range-periods__hours">{{ row.above }}</td>
              <td class="range-periods__hours">{{ row.withoutReadings }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    .range-scroll {
      overflow-x: auto;
    }
    .range-periods {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
    }
    .range-periods th,
    .range-periods td {
      text-align: left;
      vertical-align: top;
      padding: 0.2rem 0.4rem;
      white-space: nowrap;
    }
    .range-periods th[scope='row'] {
      font-weight: normal;
    }
    .range-periods .range-periods__hours {
      text-align: right;
    }
  `,
})
export class TimeInRangeTable {
  readonly rows = input.required<readonly PeriodRow[]>();
}
