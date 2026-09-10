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
import { NodeStatus, type Node } from '@tempestas/domain';

/**
 * `/nodes` was a dead nav link in the old app for years. The admit flow is the
 * point of it: a node that announces itself is inert until a human says yes,
 * because a stray ESP32 must not be able to inject a reading that starts a
 * burner.
 */
@Component({
  selector: 'temp-nodes-page',
  imports: [MatCardModule, MatButtonModule, MatChipsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Nodes</h1>
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
              <mat-chip [highlighted]="node.status === pending">{{
                node.status
              }}</mat-chip>
              <mat-chip>{{ node.online ? 'online' : 'offline' }}</mat-chip>
            </mat-chip-set>
            @if (node.status === pending) {
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
            @if (node.status === pending) {
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
  readonly pending = NodeStatus.Pending;

  constructor() {
    this.refresh();
  }

  admit(node: Node): void {
    this.api
      .admitNode(node.id)
      .subscribe({ next: () => this.refresh(), error: () => undefined });
  }

  disable(node: Node): void {
    this.api
      .disableNode(node.id)
      .subscribe({ next: () => this.refresh(), error: () => undefined });
  }

  private refresh(): void {
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));
  }
}
