import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { ApiService } from '../../core/api.service';
import type { Reading } from '@tempestas/domain';

const READINGS_SHOWN = 100;

@Component({
  selector: 'temp-readings-page',
  imports: [MatTableModule, DecimalPipe, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <table mat-table [dataSource]="readings()">
      <ng-container matColumnDef="node">
        <th mat-header-cell *matHeaderCellDef>Node</th>
        <td mat-cell *matCellDef="let reading">{{ reading.nodeId }}</td>
      </ng-container>
      <ng-container matColumnDef="sensor">
        <th mat-header-cell *matHeaderCellDef>Sensor</th>
        <td mat-cell *matCellDef="let reading">{{ reading.sensorId }}</td>
      </ng-container>
      <ng-container matColumnDef="temperature">
        <th mat-header-cell *matHeaderCellDef>°C</th>
        <td mat-cell *matCellDef="let reading">
          {{ reading.temperature | number: '1.1-1' }}
        </td>
      </ng-container>
      <ng-container matColumnDef="humidity">
        <th mat-header-cell *matHeaderCellDef>% RH</th>
        <td mat-cell *matCellDef="let reading">
          {{
            reading.humidity === null
              ? '—'
              : (reading.humidity | number: '1.0-0')
          }}
        </td>
      </ng-container>
      <ng-container matColumnDef="co2">
        <th mat-header-cell *matHeaderCellDef>ppm</th>
        <td mat-cell *matCellDef="let reading">
          {{ reading.co2 === null ? '—' : (reading.co2 | number: '1.0-0') }}
        </td>
      </ng-container>
      <ng-container matColumnDef="at">
        <th mat-header-cell *matHeaderCellDef>Taken</th>
        <td mat-cell *matCellDef="let reading">
          {{ reading.createdAt | date: 'short' }}
        </td>
      </ng-container>
      <tr mat-header-row *matHeaderRowDef="columns"></tr>
      <tr mat-row *matRowDef="let row; columns: columns"></tr>
    </table>
  `,
})
export class ReadingsPage {
  private readonly api = inject(ApiService);
  readonly columns = ['node', 'sensor', 'temperature', 'humidity', 'co2', 'at'];
  readonly readings = signal<Reading[]>([]);

  constructor() {
    this.api
      .readings({ limit: READINGS_SHOWN })
      .subscribe((rows) => this.readings.set(rows));
  }
}
