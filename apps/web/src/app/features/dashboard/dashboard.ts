import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';
import type { Node } from '@tempestas/domain';
import { ApiService } from '../../core/api.service';
import { injectLiveDevices } from '../../core/live-devices';
import { injectLiveReadings } from '../../core/live-readings';
import { injectLiveRulesCycle } from '../../core/live-rules-cycle';
import { RealtimeService } from '../../core/realtime.service';
import { injectServerNow } from '../../core/server-now';
import { secondsSince } from '../../shared/time';
import { formatDuration } from '../zones/zone-words';
import { ActivityLog } from './activity-log';
import { listAttentionItems } from './attention';
import { DashboardHero } from './dashboard-hero';
import { NodeStatCardView } from './node-stat-card';
import { buildNodeStatCards, type NodeStatCard } from './node-stats';
import { Pinboard } from '../../shared/pinboard/pinboard';
import { injectPeriodStarts } from './period-start';
import { ActivityPanel, AttentionPanel } from './side-panels';
import {
  UNKNOWN_VALUE,
  buildZoneTiles,
  describeSystemState,
} from './system-summary';

const AGE_TICK_MILLISECONDS = 10_000;
const CARD_COLUMN_MINIMUM_REM = 22;

@Component({
  selector: 'temp-dashboard',
  imports: [
    MatCardModule,
    DashboardHero,
    NodeStatCardView,
    Pinboard,
    AttentionPanel,
    ActivityPanel,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="layout">
      <temp-dashboard-hero
        class="layout__hero"
        [state]="systemState()"
        [facts]="systemFacts()"
        [tiles]="zoneTiles()"
      />

      <temp-attention-panel class="layout__attention" [items]="attention()" />

      <div class="layout__nodes">
        @if (nodeCards().length > 0) {
          <temp-pinboard
            [items]="nodeCards()"
            [identify]="identifyNodeCard"
            [columnMinimumRem]="cardColumnMinimumRem"
          >
            <ng-template let-card>
              <temp-node-stat-card [card]="card" />
            </ng-template>
          </temp-pinboard>
        } @else {
          <mat-card appearance="outlined">
            <mat-card-content>
              <p>No readings yet.</p>
              <p class="muted">
                Nodes appear here once they are admitted and start publishing.
              </p>
            </mat-card-content>
          </mat-card>
        }
      </div>

      <temp-activity-panel
        class="layout__activity"
        [entries]="activity()"
        [rulesRanAt]="cycle()?.at ?? null"
      />
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: 'hero' 'attention' 'nodes' 'activity';
    }
    @media (min-width: 64rem) {
      .layout {
        grid-template-columns: minmax(0, 1fr) 22rem;
        grid-template-areas:
          'hero hero'
          'nodes attention'
          'nodes activity';
        grid-template-rows: auto auto 1fr;
        align-items: start;
      }
    }
    .layout__hero {
      grid-area: hero;
    }
    .layout__attention {
      grid-area: attention;
    }
    .layout__activity {
      grid-area: activity;
    }
    .layout__nodes {
      grid-area: nodes;
    }
    .muted {
      opacity: 0.7;
    }
  `,
})
export class Dashboard {
  private readonly api = inject(ApiService);
  private readonly realtime = inject(RealtimeService);
  private readonly activityLog = inject(ActivityLog);

  private readonly nodes = signal<Node[]>([]);
  private readonly now = injectServerNow(AGE_TICK_MILLISECONDS);

  private readonly readings = injectLiveReadings().readings;
  private readonly devices = injectLiveDevices().devices;
  protected readonly cycle = injectLiveRulesCycle().cycle;
  private readonly periodStarts = injectPeriodStarts(this.readings);

  protected readonly systemState = computed(() =>
    describeSystemState({
      isConnected: this.realtime.connected(),
      status: this.realtime.status(),
      cycle: this.cycle(),
    }),
  );

  protected readonly systemFacts = computed(() =>
    [this.describeRulesAge(), this.describeNodesOnline()].join(' · '),
  );

  protected readonly zoneTiles = computed(() =>
    buildZoneTiles(this.cycle(), this.now()),
  );

  protected readonly attention = computed(() =>
    listAttentionItems({
      isConnected: this.realtime.connected(),
      status: this.realtime.status(),
      cycle: this.cycle(),
      readings: this.readings(),
      now: this.now(),
    }),
  );

  protected readonly nodeCards = computed(() =>
    buildNodeStatCards({
      readings: this.readings(),
      nodes: this.nodes(),
      devices: this.devices(),
      periodStarts: this.periodStarts(),
      now: this.now(),
    }),
  );

  protected readonly activity = this.activityLog.entries;
  protected readonly cardColumnMinimumRem = CARD_COLUMN_MINIMUM_REM;
  protected readonly identifyNodeCard = (card: NodeStatCard) => card.nodeId;

  constructor() {
    this.api.nodes().subscribe((nodes) => this.nodes.set(nodes));
  }

  private describeRulesAge(): string {
    const ranAt = this.cycle()?.at;
    if (!ranAt) return 'Rules have not run yet';
    return `Rules ran ${formatDuration(secondsSince(ranAt, this.now()))} ago`;
  }

  private describeNodesOnline(): string {
    const status = this.realtime.status();
    if (!status) return `${UNKNOWN_VALUE} nodes online`;
    return `${status.nodesOnline} of ${status.nodesTotal} nodes online`;
  }
}
