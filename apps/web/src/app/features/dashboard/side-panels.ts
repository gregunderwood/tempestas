import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { RouterLink } from '@angular/router';
import { ACTIVITY_KIND_LABELS, type ActivityEntry } from './activity-log';
import type { AttentionItem } from './attention';

const PANEL_STYLES = `
  :host {
    display: block;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    line-height: 1.35;
  }
  .panel__quiet {
    margin: 0;
    color: var(--mat-sys-on-surface-variant);
  }
`;

@Component({
  selector: 'temp-attention-panel',
  imports: [MatCardModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Needs attention</mat-card-title>
      </mat-card-header>
      <mat-card-content>
        @if (items().length === 0) {
          <p class="panel__quiet">Nothing needs you.</p>
        } @else {
          <ul>
            @for (item of items(); track item.key) {
              <li>
                <span aria-hidden="true">&#9888;</span>
                @if (item.link) {
                  <a [routerLink]="item.link">{{ item.text }}</a>
                } @else {
                  <span>{{ item.text }}</span>
                }
              </li>
            }
          </ul>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: PANEL_STYLES,
})
export class AttentionPanel {
  readonly items = input.required<AttentionItem[]>();
}

@Component({
  selector: 'temp-activity-panel',
  imports: [MatCardModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Activity</mat-card-title>
        <mat-card-subtitle>
          @if (rulesRanAt(); as ranAt) {
            Rules last ran at {{ ranAt | date: 'HH:mm:ss' }}
          } @else {
            Rules have not run yet
          }
        </mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (entries().length === 0) {
          <p class="panel__quiet">Nothing has changed since the app opened.</p>
        } @else {
          <ul aria-live="polite">
            @for (entry of entries(); track entry.id) {
              <li>
                <time class="activity__time" [attr.datetime]="entry.at">{{
                  entry.at | date: 'HH:mm:ss'
                }}</time>
                <span class="activity__kind" [attr.data-kind]="entry.kind">{{
                  kindLabels[entry.kind]
                }}</span>
                <span>{{ entry.text }}</span>
              </li>
            }
          </ul>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: [
    PANEL_STYLES,
    `
      .activity__time {
        flex: 0 0 auto;
        font-variant-numeric: tabular-nums;
        color: var(--mat-sys-on-surface-variant);
      }
      .activity__kind {
        flex: 0 0 auto;
        padding: 0 0.4rem;
        border: 1px solid var(--mat-sys-outline-variant);
        border-radius: 0.4rem;
        font-size: 0.75rem;
        font-weight: 600;
      }
      .activity__kind[data-kind='failure'] {
        border-color: var(--mat-sys-error);
        color: var(--mat-sys-error);
      }
    `,
  ],
})
export class ActivityPanel {
  readonly entries = input.required<readonly ActivityEntry[]>();
  readonly rulesRanAt = input.required<string | null>();

  protected readonly kindLabels = ACTIVITY_KIND_LABELS;
}
