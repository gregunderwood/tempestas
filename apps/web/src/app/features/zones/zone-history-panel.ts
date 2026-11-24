import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
  PLOT_HEIGHT,
  PLOT_WIDTH,
  type ZoneHistoryChart,
} from './zone-history-view';

@Component({
  selector: 'temp-zone-history-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="history" aria-label="Last 24 hours">
      <h3 class="history__title">Last 24 hours</h3>
      @if (chart().hasReadings) {
        <div class="plot">
          <svg
            class="plot__lines"
            role="img"
            [attr.aria-label]="chart().screenReaderText"
            [attr.viewBox]="viewBox"
            preserveAspectRatio="none"
          >
            @for (line of chart().lines; track line.key) {
              <path
                class="plot__line plot__line--{{ line.styleIndex }}"
                [class.plot__line--deciding]="line.isDeciding"
                [class.plot__line--controlling]="line.isControlling"
                [attr.d]="line.path"
                vector-effect="non-scaling-stroke"
              />
            }
          </svg>
          <span class="plot__scale plot__scale--top" aria-hidden="true">{{
            chart().topLabel
          }}</span>
          <span class="plot__scale plot__scale--bottom" aria-hidden="true">{{
            chart().bottomLabel
          }}</span>
        </div>
        <p class="history__extremes">{{ chart().extremes }}</p>
        @if (chart().lines.length > 1) {
          <ul class="legend" aria-label="Probes">
            @for (line of chart().lines; track line.key) {
              <li>
                <svg
                  class="legend__swatch"
                  viewBox="0 0 24 8"
                  aria-hidden="true"
                >
                  <path
                    class="plot__line plot__line--{{ line.styleIndex }}"
                    [class.plot__line--deciding]="line.isDeciding"
                    [class.plot__line--controlling]="line.isControlling"
                    d="M0 4 H24"
                  />
                </svg>
                {{ line.label }}
              </li>
            }
          </ul>
        }
      } @else {
        <p class="muted">No temperature readings in the last 24 hours.</p>
      }

      @for (strip of chart().strips; track strip.deviceId) {
        <div class="run">
          <div class="run__head">
            <span class="run__name">{{ strip.name }}</span>
            <span class="run__summary">{{ strip.summary }}</span>
          </div>
          <div
            class="run__strip"
            role="img"
            [attr.aria-label]="strip.screenReaderText"
          >
            @for (segment of strip.segments; track $index) {
              <span
                class="run__segment run__segment--{{ segment.state }}"
                [style.left.%]="segment.fromPercent"
                [style.width.%]="segment.widthPercent"
              ></span>
            }
          </div>
        </div>
      }

      <div class="times" aria-hidden="true">
        @for (label of chart().timeLabels; track label.atPercent) {
          <span [style.left.%]="label.atPercent">{{ label.text }}</span>
        }
        <span class="times__now">now</span>
      </div>

      @if (chart().strips.length > 0) {
        <ul class="key" aria-label="Key">
          <li><span class="key__swatch run__segment--on"></span>on</li>
          <li><span class="key__swatch run__segment--off"></span>off</li>
          <li>
            <span class="key__swatch run__segment--unknown"></span>unknown
          </li>
        </ul>
      }
    </section>
  `,
  styles: `
    .history {
      margin-top: 1rem;
    }
    .history__title {
      font-size: 0.9rem;
      font-weight: 600;
      margin: 0 0 0.4rem;
    }
    .plot {
      position: relative;
      height: 6rem;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      border-top: 1px dashed var(--mat-sys-outline-variant);
    }
    .plot__lines {
      display: block;
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .plot__line {
      fill: none;
      stroke: var(--mat-sys-on-surface);
      stroke-width: 1.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0.7;
    }
    .plot__line--1 {
      stroke-dasharray: 6 3;
    }
    .plot__line--2 {
      stroke-dasharray: 2 3;
    }
    .plot__line--3 {
      stroke-dasharray: 8 3 2 3;
    }
    .plot__line--deciding {
      stroke: var(--temp-gauge-blue);
      stroke-width: 2.5px;
      opacity: 1;
    }
    .plot__line--controlling {
      stroke-width: 3.5px;
    }
    .plot__scale {
      position: absolute;
      left: 0;
      font-size: 0.7rem;
      line-height: 1;
      padding: 0 0.2rem;
      background: var(--mat-sys-surface);
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
    }
    .plot__scale--top {
      top: 0.15rem;
    }
    .plot__scale--bottom {
      bottom: 0.15rem;
    }
    .history__extremes {
      margin: 0.3rem 0 0;
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;
    }
    .legend,
    .key {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.9rem;
      list-style: none;
      margin: 0.3rem 0 0;
      padding: 0;
      font-size: 0.75rem;
    }
    .legend li,
    .key li {
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    .legend__swatch {
      width: 1.5rem;
      height: 0.5rem;
    }
    .run {
      margin-top: 0.5rem;
    }
    .run__head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0 0.75rem;
      font-size: 0.8rem;
      margin-bottom: 0.15rem;
    }
    .run__summary {
      opacity: 0.75;
      font-variant-numeric: tabular-nums;
    }
    .run__strip {
      position: relative;
      height: 0.75rem;
      border-radius: 3px;
      border: 1px solid var(--mat-sys-outline-variant);
      overflow: hidden;
    }
    .run__segment {
      position: absolute;
      top: 0;
      bottom: 0;
    }
    .run__segment--on {
      background: var(--temp-gauge-orange);
    }
    .run__segment--off {
      background: var(--mat-sys-surface-container-highest);
    }
    .run__segment--unknown {
      background: repeating-linear-gradient(
        135deg,
        var(--mat-sys-outline) 0 2px,
        transparent 2px 6px
      );
    }
    .times {
      position: relative;
      height: 1rem;
      margin-top: 0.15rem;
      font-size: 0.7rem;
      opacity: 0.75;
      font-variant-numeric: tabular-nums;
    }
    .times span {
      position: absolute;
      transform: translateX(-50%);
      white-space: nowrap;
    }
    .times .times__now {
      right: 0;
      transform: none;
    }
    .key__swatch {
      display: inline-block;
      width: 1rem;
      height: 0.6rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 2px;
    }
    .muted {
      opacity: 0.7;
      font-size: 0.85rem;
      margin: 0;
    }
  `,
})
export class ZoneHistoryPanel {
  readonly chart = input.required<ZoneHistoryChart>();
  protected readonly viewBox = `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`;
}
