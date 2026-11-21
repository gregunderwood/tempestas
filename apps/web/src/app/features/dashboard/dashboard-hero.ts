import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { formatDuration } from '../zones/zone-words';
import type { SystemState, ZoneTile } from './system-summary';

const TONE_MARKS: Record<SystemState['tone'], string> = {
  calm: '●',
  warn: '▲',
  alarm: '⚠',
};

@Component({
  selector: 'temp-dashboard-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="hero" aria-labelledby="hero-headline">
      <p class="hero__state" [attr.data-tone]="state().tone">
        <span aria-hidden="true">{{ toneMarks[state().tone] }}</span>
        <span id="hero-headline">{{ state().headline }}</span>
      </p>
      <p class="hero__facts">{{ facts() }}</p>

      @if (tiles().length > 0) {
        <ul class="tiles" aria-label="What each zone decided">
          @for (tile of tiles(); track tile.key) {
            <li class="tile" [attr.data-tone]="tile.tone">
              <span class="tile__where"
                >{{ tile.zoneSlug }} · {{ tile.roleLabel }}</span
              >
              <span class="tile__reading">{{ tile.reading }}</span>
              <span class="tile__decision">{{ tile.decision }}</span>
              @if (tile.unappliedBecause) {
                <span class="tile__unapplied"
                  >Not switched: {{ tile.unappliedBecause }}</span
                >
              }
              <span class="tile__age"
                >decided {{ formatDuration(tile.decidedSecondsAgo) }} ago</span
              >
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: `
    .hero {
      padding: 1.5rem;
      border-radius: 1.25rem;
      background: linear-gradient(
        135deg,
        var(--temp-hero-start),
        var(--temp-hero-end)
      );
      color: var(--temp-hero-foreground);
    }
    .hero__state {
      display: flex;
      gap: 0.6rem;
      align-items: baseline;
      margin: 0;
      font-size: 1.6rem;
      font-weight: 600;
      line-height: 1.25;
    }
    .hero__state[data-tone='alarm'] {
      text-decoration: underline;
      text-decoration-thickness: 3px;
      text-underline-offset: 6px;
    }
    .hero__facts {
      margin: 0.4rem 0 0;
      opacity: 0.85;
    }
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
      gap: 0.75rem;
      margin: 1.25rem 0 0;
      padding: 0;
      list-style: none;
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      padding: 0.85rem 1rem;
      border-radius: 0.85rem;
      background: rgb(255 255 255 / 10%);
      border-left: 4px solid transparent;
    }
    .tile[data-tone='on'] {
      border-left-color: currentColor;
    }
    .tile[data-tone='warn'] {
      border-left-style: dashed;
      border-left-color: currentColor;
    }
    .tile__where {
      font-size: 0.85rem;
      opacity: 0.85;
    }
    .tile__reading {
      font-size: 1.6rem;
      font-weight: 600;
    }
    .tile__decision {
      font-weight: 500;
    }
    .tile__unapplied {
      font-size: 0.85rem;
      font-style: italic;
    }
    .tile__age {
      font-size: 0.8rem;
      opacity: 0.75;
    }
  `,
})
export class DashboardHero {
  readonly state = input.required<SystemState>();
  readonly facts = input.required<string>();
  readonly tiles = input.required<ZoneTile[]>();

  protected readonly toneMarks = TONE_MARKS;
  protected readonly formatDuration = formatDuration;
}
