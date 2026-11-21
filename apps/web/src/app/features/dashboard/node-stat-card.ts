import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import type { NodeStatCard } from './node-stats';
import { UNKNOWN_VALUE } from './system-summary';

@Component({
  selector: 'temp-node-stat-card',
  imports: [MatCardModule, RouterLink, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined" [class.card--quiet]="card().isQuiet">
      <mat-card-header>
        <mat-card-title>
          <a [routerLink]="['/nodes', card().nodeId]">{{ card().title }}</a>
        </mat-card-title>
        <mat-card-subtitle class="age" [class.age--quiet]="card().isQuiet">
          @if (card().isQuiet) {
            <span aria-hidden="true">&#9888;</span>
          }
          {{ card().age }}
        </mat-card-subtitle>
      </mat-card-header>

      <mat-card-content>
        <div class="stats">
          @for (metric of card().metrics; track metric.key) {
            <div class="stat">
              <span class="stat__label">
                {{ metric.label }}
                @if (metric.sensorCaption) {
                  <span class="stat__sensor">{{ metric.sensorCaption }}</span>
                }
              </span>
              <span class="stat__value"
                >{{ metric.value }}
                <span class="stat__unit">{{ metric.unit }}</span></span
              >
              <span class="stat__trend">{{ metric.trend }}</span>
              @if (metric.rangePercent === null) {
                <span class="stat__range-unknown">{{ unknownValue }}</span>
              } @else {
                <span class="stat__range" aria-hidden="true">
                  <span
                    class="stat__range-fill"
                    [style.width.%]="metric.rangePercent"
                    [style.background]="'var(--temp-gauge-' + metric.band + ')'"
                  ></span>
                </span>
              }
            </div>
          }
        </div>

        @if (card().relays.length > 0) {
          <ul class="relays" aria-label="Relays on this node">
            @for (relay of card().relays; track relay.id) {
              <li class="relay" [class.relay--on]="relay.isOn">
                <span>{{ relay.name }}</span>
                <span class="relay__state">
                  @if (relay.isOn) {
                    ON
                    @if (relay.onAt) {
                      since {{ relay.onAt | date: relay.onAtFormat }}
                    }
                  } @else {
                    off
                  }
                </span>
              </li>
            }
          </ul>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    :host {
      display: block;
    }
    mat-card-title a {
      color: inherit;
      text-decoration-color: var(--mat-sys-outline);
      text-underline-offset: 4px;
    }
    .card--quiet {
      border-color: var(--temp-gauge-orange);
    }
    .age--quiet {
      color: var(--temp-gauge-orange);
      font-weight: 600;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
      gap: 1rem;
      margin: 0.5rem 0 1rem;
    }
    .stat {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .stat__label {
      color: var(--mat-sys-on-surface-variant);
      font-size: 0.85rem;
    }
    .stat__sensor {
      display: block;
      font-size: 0.75rem;
    }
    .stat__value {
      font-size: 2rem;
      font-weight: 600;
      line-height: 1.1;
    }
    .stat__unit {
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--mat-sys-on-surface-variant);
    }
    .stat__trend {
      font-size: 0.8rem;
      color: var(--mat-sys-on-surface-variant);
    }
    .stat__range {
      display: block;
      height: 0.4rem;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
      overflow: hidden;
    }
    .stat__range-fill {
      display: block;
      height: 100%;
    }
    .stat__range-unknown {
      font-size: 0.8rem;
      line-height: 0.4rem;
    }
    .relays {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .relay {
      display: inline-flex;
      gap: 0.5rem;
      padding: 0.3rem 0.75rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 999px;
      font-size: 0.9rem;
    }
    .relay__state {
      font-weight: 700;
    }
    .relay--on {
      border-color: var(--temp-gauge-orange);
      background: color-mix(in srgb, var(--temp-gauge-orange) 14%, transparent);
    }
  `,
})
export class NodeStatCardView {
  readonly card = input.required<NodeStatCard>();

  protected readonly unknownValue = UNKNOWN_VALUE;
}
