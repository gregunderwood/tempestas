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

// A 240 degree arc from lower-left to lower-right, filled with stroke-dasharray rather than trigonometry.
const ARC_PATH = 'M 22 74 A 44 44 0 1 1 98 74';
const ARC_LENGTH = 184.3;

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
        <path class="gauge__track" [attr.d]="arcPath" />
        @if (value() !== null) {
          <path
            class="gauge__value"
            [attr.d]="arcPath"
            [attr.stroke-dasharray]="arcLength"
            [attr.stroke-dashoffset]="dashOffset()"
          />
        }
      </svg>
      <figcaption>
        <span class="gauge__reading">
          <!-- "0 ppm" reads as extremely low, the one direction that runs the burner. -->
          @if (value() === null) {
            <span class="gauge__number">—</span>
          } @else {
            <span class="gauge__number">{{
              value() | number: numberFormat()
            }}</span>
          }
          <span class="gauge__unit">{{ metric().unit }}</span>
        </span>
        <span class="gauge__label">{{ metric().label }}</span>
        @if (value() === null) {
          <span class="gauge__unknown">unknown</span>
        }
      </figcaption>
    </figure>
  `,
  styles: `
    /* The grid item is this host, and an inline host refuses to shrink below its content. */
    :host {
      display: block;
      min-width: 0;
    }
    /* Capped on the figure, the cqw container, so the caption's pull-up never clips the arc. */
    .gauge {
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-width: 0;
      max-width: 9rem;
      container-type: inline-size;
    }
    svg {
      display: block;
      width: 100%;
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
      /* Proportional to the gauge, so it stays in the arc's open bottom as the column narrows. */
      margin-top: -20cqw;
      max-width: 100%;
    }
    .gauge__reading {
      display: flex;
      align-items: baseline;
      gap: 0.25rem;
    }
    .gauge__number {
      /* Floored at a size still readable at arm's length in sunlight. */
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
  readonly value = input.required<number | null>();

  protected readonly arcPath = ARC_PATH;
  protected readonly arcLength = ARC_LENGTH;

  protected readonly metric = computed(() => GAUGE_METRICS[this.metricKey()]);
  protected readonly numberFormat = computed(() => {
    const decimals = this.metric().decimals;
    return `1.${decimals}-${decimals}`;
  });

  protected readonly color = computed(() => {
    const band = gaugeColorFor(this.metric(), this.value());
    return band === null ? null : `var(--temp-gauge-${band})`;
  });

  protected readonly fraction = computed(() => {
    const value = this.value();
    if (value === null) return 0;
    const { min, max } = this.metric();
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
  });

  protected readonly dashOffset = computed(
    () => ARC_LENGTH * (1 - this.fraction()),
  );

  protected readonly ariaLabel = computed(() => {
    const metric = this.metric();
    const value = this.value();
    return value === null
      ? `${metric.label} unknown`
      : `${metric.label} ${value.toFixed(metric.decimals)} ${metric.unit}`;
  });
}
