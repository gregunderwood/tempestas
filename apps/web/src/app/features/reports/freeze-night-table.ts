import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { NightRow } from './freeze-margin-rows';

@Component({
  selector: 'temp-freeze-night-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table class="freeze-nights">
      <thead>
        <tr>
          <th scope="col">Night</th>
          <th scope="col">Coldest</th>
          <th scope="col">Heat then</th>
          <th scope="col" class="freeze-nights__hours">
            Below {{ warningBelowC() }} °C
          </th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.from) {
          <tr [class.freeze-nights__flagged]="row.concern !== null">
            <th scope="row">{{ row.label }}</th>
            <td>{{ row.coldest }}</td>
            <td>{{ row.heating }}</td>
            <td class="freeze-nights__hours">{{ row.hoursBelow }}</td>
          </tr>
          @if (row.concern) {
            <tr class="freeze-nights__concern">
              <td colspan="4">{{ row.concern }}</td>
            </tr>
          }
        }
      </tbody>
    </table>
  `,
  styles: `
    .freeze-nights {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
      font-variant-numeric: tabular-nums;
    }
    .freeze-nights th,
    .freeze-nights td {
      text-align: left;
      vertical-align: top;
      padding: 0.2rem 0.4rem;
    }
    .freeze-nights th[scope='row'] {
      font-weight: normal;
      white-space: nowrap;
    }
    .freeze-nights .freeze-nights__hours {
      text-align: right;
    }
    .freeze-nights__flagged th,
    .freeze-nights__flagged td,
    .freeze-nights__concern td {
      color: var(--temp-gauge-red);
    }
    .freeze-nights__concern td {
      font-size: 0.8rem;
      padding-bottom: 0.5rem;
    }
  `,
})
export class FreezeNightTable {
  readonly rows = input.required<readonly NightRow[]>();
  readonly warningBelowC = input.required<number>();
}
