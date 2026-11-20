import type {
  ClimateSample,
  Co2BurnerRule,
  DaylightThermostatRule,
  RoleRule,
  ThermostatRule,
} from '@tempestas/domain';

export type SegmentKind = 'on' | 'band' | 'off';
export type BarSide = 'low' | 'high';

export interface BarSegment {
  kind: SegmentKind;
  fromPercent: number;
  widthPercent: number;
}

export interface BarLabel {
  atPercent: number;
  text: string;
}

export interface BarMarker {
  atPercent: number;
  offScale: BarSide | null;
}

export interface ThresholdBar {
  caption: string;
  segments: BarSegment[];
  labels: BarLabel[];
  readingText: string;
  marker: BarMarker | null;
  screenReaderText: string;
}

export interface BarScale {
  unit: string;
  minimumPadding: number;
  decimals: number;
}

export interface BarSpec {
  caption: string;
  scale: BarScale;
  onSide: BarSide;
  onAt: number;
  offAt: number;
  reading: number | null;
}

export interface RuleBars {
  bars: ThresholdBar[];
  notes: string[];
}

export const TEMPERATURE_SCALE: BarScale = {
  unit: ' °C',
  minimumPadding: 3,
  decimals: 1,
};

export const CO2_SCALE: BarScale = {
  unit: ' ppm',
  minimumPadding: 300,
  decimals: 0,
};

const PADDING_PER_BAND_WIDTH = 1.5;
const MERGE_LABELS_CLOSER_THAN_PERCENT = 20;

interface BarWindow {
  low: number;
  high: number;
  minimum: number;
  maximum: number;
  toPercent(value: number): number;
}

export function buildRuleBars(
  rule: RoleRule,
  climate: ClimateSample | null,
): RuleBars {
  switch (rule.kind) {
    case 'thermostat':
    case 'daylight-thermostat':
      return buildThermostatBars(rule, climate);
    case 'co2-burner':
      return buildCo2BurnerBars(rule, climate);
    default:
      throw new Error(
        `unknown rule kind "${String((rule as { kind?: unknown }).kind)}"`,
      );
  }
}

function buildThermostatBars(
  rule: ThermostatRule | DaylightThermostatRule,
  climate: ClimateSample | null,
): RuleBars {
  const isDaylightOnly = rule.kind === 'daylight-thermostat';
  return {
    bars: [
      buildThresholdBar({
        caption: 'Temperature',
        scale: TEMPERATURE_SCALE,
        onSide: rule.mode === 'heat' ? 'low' : 'high',
        onAt: rule.onAtC,
        offAt: rule.offAtC,
        reading: climate?.temperatureC ?? null,
      }),
    ],
    notes: isDaylightOnly
      ? ['Only inside the daylight window; off outside it.']
      : [],
  };
}

function buildCo2BurnerBars(
  rule: Co2BurnerRule,
  climate: ClimateSample | null,
): RuleBars {
  return {
    bars: [
      buildThresholdBar({
        caption: 'CO₂ (day)',
        scale: CO2_SCALE,
        onSide: 'low',
        onAt: rule.co2OnPpm,
        offAt: rule.co2OffPpm,
        reading: climate?.co2Ppm ?? null,
      }),
    ],
    notes: [
      `Day: off at or above ${rule.dayOffAtC} °C, whatever the CO₂.`,
      `Night: a heater - on below ${rule.nightOnBelowC} °C, CO₂ ignored.`,
    ],
  };
}

export function buildThresholdBar(spec: BarSpec): ThresholdBar {
  assertThresholdsAreNumbers(spec);
  const window = buildWindow(spec);
  const readingText = describeReading(spec);
  return {
    caption: spec.caption,
    segments: buildSegments(window, spec.onSide),
    labels: buildThresholdLabels(window, spec.scale),
    readingText,
    marker: placeMarker(spec.reading, window),
    screenReaderText: describeBar(spec, readingText),
  };
}

function assertThresholdsAreNumbers(spec: BarSpec): void {
  if (!Number.isFinite(spec.onAt) || !Number.isFinite(spec.offAt)) {
    throw new Error(`${spec.caption} thresholds are not numbers`);
  }
}

function buildWindow(spec: BarSpec): BarWindow {
  const low = Math.min(spec.onAt, spec.offAt);
  const high = Math.max(spec.onAt, spec.offAt);
  // Sized from the thresholds, never the reading, so a rule always draws the same bar.
  const padding = Math.max(
    spec.scale.minimumPadding,
    (high - low) * PADDING_PER_BAND_WIDTH,
  );
  const minimum = low - padding;
  const maximum = high + padding;
  return {
    low,
    high,
    minimum,
    maximum,
    toPercent: (value) => ((value - minimum) / (maximum - minimum)) * 100,
  };
}

function buildSegments(window: BarWindow, onSide: BarSide): BarSegment[] {
  const lowPercent = window.toPercent(window.low);
  const highPercent = window.toPercent(window.high);
  const [belowBand, aboveBand]: SegmentKind[] =
    onSide === 'low' ? ['on', 'off'] : ['off', 'on'];
  return [
    { kind: belowBand, fromPercent: 0, widthPercent: lowPercent },
    {
      kind: 'band',
      fromPercent: lowPercent,
      widthPercent: highPercent - lowPercent,
    },
    {
      kind: aboveBand,
      fromPercent: highPercent,
      widthPercent: 100 - highPercent,
    },
  ];
}

function buildThresholdLabels(window: BarWindow, scale: BarScale): BarLabel[] {
  const lowPercent = window.toPercent(window.low);
  const highPercent = window.toPercent(window.high);
  const areLabelsCrowded =
    highPercent - lowPercent < MERGE_LABELS_CLOSER_THAN_PERCENT;
  if (areLabelsCrowded) {
    return [
      {
        atPercent: (lowPercent + highPercent) / 2,
        text: `${window.low.toFixed(scale.decimals)}–${formatValue(window.high, scale)}`,
      },
    ];
  }
  return [
    { atPercent: lowPercent, text: formatValue(window.low, scale) },
    { atPercent: highPercent, text: formatValue(window.high, scale) },
  ];
}

function placeMarker(
  reading: number | null,
  window: BarWindow,
): BarMarker | null {
  if (reading === null) return null;
  if (reading < window.minimum) return { atPercent: 0, offScale: 'low' };
  if (reading > window.maximum) return { atPercent: 100, offScale: 'high' };
  return { atPercent: window.toPercent(reading), offScale: null };
}

function describeReading(spec: BarSpec): string {
  return spec.reading === null
    ? 'no reading'
    : `now ${formatValue(spec.reading, spec.scale)}`;
}

function describeBar(spec: BarSpec, readingText: string): string {
  const [onDirection, offDirection] =
    spec.onSide === 'low' ? ['below', 'above'] : ['above', 'below'];
  return (
    `${spec.caption}: on ${onDirection} ${formatValue(spec.onAt, spec.scale)}, ` +
    `off ${offDirection} ${formatValue(spec.offAt, spec.scale)}, holding in between; ${readingText}.`
  );
}

function formatValue(value: number, scale: BarScale): string {
  return `${value.toFixed(scale.decimals)}${scale.unit}`;
}
