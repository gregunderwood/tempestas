import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';
import { refreshAfterSuccess } from '../../core/refresh-after-success';
import { NodeStatus, type Node } from '@tempestas/domain';

@Component({
  selector: 'temp-nodes-page',
  imports: [MatCardModule, MatButtonModule, MatChipsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="temp-cards">
      @for (node of nodes(); track node.id) {
        <mat-card appearance="outlined">
          <mat-card-header>
            <mat-card-title>
              <a [routerLink]="['/nodes', node.slug]">{{ node.displayName }}</a>
            </mat-card-title>
            <mat-card-subtitle
              >{{ node.slug }} · {{ node.kind }}</mat-card-subtitle
            >
          </mat-card-header>
          <mat-card-content>
            <mat-chip-set>
              <mat-chip [highlighted]="isPending(node)">{{
                node.status
              }}</mat-chip>
              <mat-chip>{{ node.online ? 'online' : 'offline' }}</mat-chip>
            </mat-chip-set>
            @if (isPending(node)) {
              <p class="temp-warn">
                Receiving no commands, and its readings are discarded, until it
                is admitted.
              </p>
            }
            <p class="temp-muted">
              {{ node.deviceCount }} device(s) · agent
              {{ node.agentVersion ?? 'unknown' }}
            </p>
          </mat-card-content>
          <mat-card-actions>
            @if (isPending(node)) {
              <button mat-flat-button (click)="admit(node)">Admit</button>
            } @else {
              <button mat-button (click)="disable(node)">Disable</button>
            }
          </mat-card-actions>
        </mat-card>
      }
    </div>
  `,
  styles: `
    .temp-cards {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
    }
    .temp-muted {
      opacity: 0.7;
      font-size: 0.85rem;
    }
    mat-card-title a {
      color: inherit;
      text-decoration-color: var(--mat-sys-outline);
      text-underline-offset: 4px;
    }
    .temp-warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class NodesPage {
  private readonly api = inject(ApiService);
  readonly nodes = signal<Node[]>([]);

  constructor() {
    this.refresh();
  }

  protected isPending(node: Node): boolean {
    return node.status === NodeStatus.Pending;
  }

  admit(node: Node): void {
    refreshAfterSuccess(this.api.admitNode(node.id), () => this.refresh());
  }

  disable(node: Node): void {
    refreshAfterSuccess(this.api.disableNode(node.id), () => this.refresh());
  }

  private refresh(): void {
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));
  }
}
