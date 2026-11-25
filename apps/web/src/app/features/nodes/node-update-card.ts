import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import {
  describeAgent,
  isUpdateInProgress,
  NodeUpdateOutcome,
  type Node,
  type NodeUpdate,
} from '@tempestas/domain';

export type UpdateAction = 'update' | 'roll-back';

export interface UpdateConfirmation {
  action: UpdateAction;
  version: string;
}

interface PendingConfirmation extends UpdateConfirmation {
  nodeId: string;
}

const OUTCOME_LABELS: Record<NodeUpdateOutcome, string> = {
  [NodeUpdateOutcome.InProgress]: 'in progress',
  [NodeUpdateOutcome.Healthy]: 'healthy',
  [NodeUpdateOutcome.RolledBack]: 'rolled itself back',
  [NodeUpdateOutcome.Failed]: 'failed',
  [NodeUpdateOutcome.TimedOut]: 'no answer',
};

@Component({
  selector: 'temp-node-update-card',
  imports: [DatePipe, MatButtonModule, MatCardModule, MatProgressBarModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-header>
        <mat-card-title>Software</mat-card-title>
        <mat-card-subtitle>{{ agent() }}</mat-card-subtitle>
      </mat-card-header>
      <mat-card-content>
        @if (updateInProgress(); as update) {
          <p class="progress" role="status">
            {{ describeAttempt(update) }}:
            <strong>{{ update.lastState ?? 'sent' }}</strong>
          </p>
          <mat-progress-bar mode="indeterminate" />
        } @else if (isSending()) {
          <p class="progress" role="status">Sending…</p>
          <mat-progress-bar mode="indeterminate" />
        } @else if (shownConfirmation(); as pending) {
          <p class="caution">
            {{ node().displayName }} restarts, and its relays go to their
            fail-safe levels for a few seconds. If {{ pending.version }} does
            not come up healthy, the node goes back to what it runs now.
          </p>
          <div class="actions">
            <button mat-flat-button (click)="confirm(pending)">
              {{ labelAction(pending) }}
            </button>
            <button mat-button (click)="confirmation.set(null)">Cancel</button>
          </div>
        } @else if (hasAction()) {
          <div class="actions">
            @if (node().availableUpdate; as version) {
              <button
                mat-flat-button
                [disabled]="isBlocked()"
                (click)="ask('update', version)"
              >
                Update to {{ version }}
              </button>
            }
            @if (node().updateSummary.rollBackVersion; as version) {
              <button
                mat-stroked-button
                [disabled]="isBlocked()"
                (click)="ask('roll-back', version)"
              >
                Roll back to {{ version }}
              </button>
            }
          </div>
          @if (node().updateSummary.blockedBecause; as reason) {
            <p class="blocked">{{ reason }}</p>
          }
        } @else if (node().updateSummary.notUpdatableBecause; as reason) {
          <p class="quiet">{{ reason }}</p>
        } @else {
          <p class="quiet">Up to date.</p>
        }

        @if (finishedUpdate(); as update) {
          <p class="last" [class.last--bad]="isBadOutcome(update)">
            {{ describeAttempt(update) }}: {{ labelOutcome(update) }},
            {{ update.finishedAt | date: 'MMM d, HH:mm' }}
            @if (update.reason) {
              <span class="reason">{{ update.reason }}</span>
            }
          </p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: `
    :host {
      display: block;
    }
    mat-card {
      margin-bottom: 1rem;
      max-width: 46rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin: 0.25rem 0 0.5rem;
    }
    .progress {
      margin: 0 0 0.5rem;
    }
    .caution {
      margin: 0 0 0.5rem;
      color: var(--temp-gauge-orange);
    }
    .blocked,
    .quiet {
      margin: 0.25rem 0 0;
      font-size: 0.85rem;
      opacity: 0.75;
    }
    .last {
      margin: 0.75rem 0 0;
      font-size: 0.85rem;
    }
    .last--bad {
      color: var(--mat-sys-error);
    }
    .reason {
      display: block;
      opacity: 0.85;
    }
  `,
})
export class NodeUpdateCard {
  readonly node = input.required<Node>();
  readonly isSending = input(false);
  readonly confirmed = output<UpdateConfirmation>();

  protected readonly confirmation = signal<PendingConfirmation | null>(null);

  protected readonly shownConfirmation = computed(() => {
    const pending = this.confirmation();
    return pending && this.isStillOffered(pending) ? pending : null;
  });

  protected readonly agent = computed(() => describeAgent(this.node()));

  protected readonly updateInProgress = computed(() => {
    const lastUpdate = this.node().updateSummary.lastUpdate;
    return isUpdateInProgress(lastUpdate) ? lastUpdate : null;
  });

  protected readonly finishedUpdate = computed(() => {
    const lastUpdate = this.node().updateSummary.lastUpdate;
    return isUpdateInProgress(lastUpdate) ? null : lastUpdate;
  });

  protected readonly hasAction = computed(
    () =>
      this.node().availableUpdate !== null ||
      this.node().updateSummary.rollBackVersion !== null,
  );

  protected readonly isBlocked = computed(
    () => this.node().updateSummary.blockedBecause !== null,
  );

  constructor() {
    effect(() => this.dropStaleConfirmation());
  }

  protected ask(action: UpdateAction, version: string): void {
    this.confirmation.set({ action, version, nodeId: this.node().id });
  }

  protected confirm({ action, version }: PendingConfirmation): void {
    this.confirmation.set(null);
    this.confirmed.emit({ action, version });
  }

  // Dropped, not just hidden, so it does not come back unasked once the block lifts.
  private dropStaleConfirmation(): void {
    if (this.confirmation() && !this.shownConfirmation()) {
      this.confirmation.set(null);
    }
  }

  private isStillOffered(pending: PendingConfirmation): boolean {
    return (
      !this.isBlocked() &&
      pending.nodeId === this.node().id &&
      this.findOffered(pending.action) === pending.version
    );
  }

  private findOffered(action: UpdateAction): string | null {
    return action === 'update'
      ? this.node().availableUpdate
      : this.node().updateSummary.rollBackVersion;
  }

  protected labelAction(pending: PendingConfirmation): string {
    const verb = pending.action === 'update' ? 'Update' : 'Roll back';
    return `${verb} to ${pending.version}`;
  }

  protected describeAttempt(update: NodeUpdate): string {
    const verb = update.isRollBack ? 'Roll back' : 'Update';
    return `${verb} to ${update.toVersion}`;
  }

  protected labelOutcome(update: NodeUpdate): string {
    return OUTCOME_LABELS[update.outcome];
  }

  protected isBadOutcome(update: NodeUpdate): boolean {
    return update.outcome !== NodeUpdateOutcome.Healthy;
  }
}
