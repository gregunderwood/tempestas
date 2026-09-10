import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import {
  GAUGE_METRICS,
  gaugeColorFor,
  type GaugeMetricKey,
} from '@tempestas/domain';

/**
 * One reading, as an arc.
 *
 * The ranges and colour bands come from `@tempestas/domain` rather than living
 * here, because the rules engine and this gauge have to agree about what
 * "orange" means. In the old app the gauge config was copy-pasted nine times
 * across two templates and the thresholds sat on a service as `any`.
 *
 * Read on a phone, in a greenhouse, in sunlight, sometimes with wet hands - so
 * the number is large, the arc is thick, and nothing conveys meaning by colour
 * alone.
 */
@Component({
  selector: 'temp-gauge',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure
      class="gauge"
      [class.gauge--unknown]="value() === null"
      [style.--gauge-color]="color()"
    >
      <svg viewBox="0 0 120 84" role="img" [attr.aria-label]="ariaLabel()">
        <path class="gauge__track" [attr.d]="ARC" />
        @if (value() !== null) {
          <path
            class="gauge__value"
            [attr.d]="ARC"
            [attr.stroke-dasharray]="ARC_LENGTH"
            [attr.stroke-dashoffset]="dashOffset()"
          />
        }
      </svg>
      <figcaption>
        <span class="gauge__reading">
          <!-- An em-dash, never a zero. Null means the sensor had no answer,
               and "0 ppm" reads as extremely low - the one direction that
               runs the burner. -->
          @if (value() === null) {
            <span class="gauge__number">—</span>
          } @else {
            <span class="gauge__number">{{ value() | number: digits() }}</span>
          }
          <span class="gauge__unit">{{ metric().unit }}</span>
        </span>
        <span class="gauge__label">{{ metric().label }}</span>
        <!-- Never colour alone: unknown states its own name. -->
        @if (value() === null) {
          <span class="gauge__unknown">unknown</span>
        }
      </figcaption>
    </figure>
  `,
  styles: `
    /* The grid item is this host, not the figure inside it. An inline host has
       an auto min-width and refuses to shrink, which pushed the third gauge on
       every card off the side of a phone screen. */
    :host {
      display: block;
      min-width: 0;
    }
    .gauge {
      margin: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      /* No min-width: a fixed one makes the figure wider than its grid column
         and the reading spills across the arc. */
      min-width: 0;
      container-type: inline-size;
    }
    svg {
      display: block;
      width: 100%;
      max-width: 9rem;
      height: auto;
    }
    .gauge__track,
    .gauge__value {
      fill: none;
      stroke-width: 12;
      stroke-linecap: round;
    }
    .gauge__track {
      stroke: var(--mat-sys-surface-container-highest);
    }
    .gauge__value {
      stroke: var(--gauge-color, var(--mat-sys-primary));
      transition: stroke-dashoffset 400ms ease-out;
    }
    @media (prefers-reduced-motion: reduce) {
      .gauge__value {
        transition: none;
      }
    }
    figcaption {
      display: flex;
      flex-direction: column;
      align-items: center;
      /* Pulled up into the arc's open bottom. Proportional to the gauge rather
         than fixed, so it stays put as the column narrows. */
      margin-top: -20cqw;
      max-width: 100%;
    }
    .gauge__reading {
      display: flex;
      align-items: baseline;
      gap: 0.25rem;
    }
    .gauge__number {
      /* Scales with the gauge so a four-digit CO2 still fits inside the arc.
         Floored at a size that stays readable at arm's length in sunlight. */
      font-size: clamp(0.95rem, 17cqw, 1.7rem);
      font-weight: 500;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }
    .gauge__unit {
      font-size: clamp(0.6rem, 8cqw, 0.8rem);
      opacity: 0.75;
    }
    .gauge__label {
      font-size: clamp(0.6rem, 8cqw, 0.8rem);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.75;
    }
    .gauge--unknown .gauge__number {
      opacity: 0.55;
    }
    .gauge__unknown {
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0.75;
    }
  `,
})
export class Gauge {
  readonly metricKey = input.required<GaugeMetricKey>();
  /** `null` is unknown, and renders as an em-dash. It is never treated as 0. */
  readonly value = input.required<number | null>();

  /**
   * A 240° arc from lower-left to lower-right, and its length, so the fill can
   * be drawn with `stroke-dasharray` instead of trigonometry per frame.
   */
  protected readonly ARC = 'M 22 74 A 44 44 0 1 1 98 74';
  protected readonly ARC_LENGTH = 184.3;

  protected readonly metric = computed(() => GAUGE_METRICS[this.metricKey()]);
  protected readonly digits = computed(() => {
    const d = this.metric().decimals;
    return `1.${d}-${d}`;
  });

  protected readonly color = computed(() => {
    const name = gaugeColorFor(this.metric(), this.value());
    return name === null ? null : `var(--temp-gauge-${name})`;
  });

  /** Clamped, so an out-of-range reading fills the arc rather than overflowing it. */
  protected readonly fraction = computed(() => {
    const value = this.value();
    if (value === null) return 0;
    const { min, max } = this.metric();
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
  });

  protected readonly dashOffset = computed(
    () => this.ARC_LENGTH * (1 - this.fraction()),
  );

  protected readonly ariaLabel = computed(() => {
    const m = this.metric();
    const v = this.value();
    return v === null
      ? `${m.label} unknown`
      : `${m.label} ${v.toFixed(m.decimals)} ${m.unit}`;
  });
}
