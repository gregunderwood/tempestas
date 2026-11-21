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
  isStale: boolean;
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

export interface BarDefinition {
  caption: string;
  scale: BarScale;
  onSide: BarSide;
  onAt: number;
  offAt: number;
  reading: number | null;
  isReadingStale: boolean;
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

export const FULL_SCALE_PERCENT = 100;

const PADDING_PER_BAND_WIDTH = 1.5;
const MERGE_LABELS_CLOSER_THAN_PERCENT = 20;

interface BarWindow {
  low: number;
  high: number;
  lowPercent: number;
  highPercent: number;
  minimum: number;
  maximum: number;
  toPercent(value: number): number;
}

interface SideLayout {
  belowBand: SegmentKind;
  aboveBand: SegmentKind;
  onDirection: string;
  offDirection: string;
}

const SIDE_LAYOUTS: Record<BarSide, SideLayout> = {
  low: {
    belowBand: 'on',
    aboveBand: 'off',
    onDirection: 'below',
    offDirection: 'above',
  },
  high: {
    belowBand: 'off',
    aboveBand: 'on',
    onDirection: 'above',
    offDirection: 'below',
  },
};

export function buildRuleBars(
  rule: RoleRule,
  climate: ClimateSample | null,
  isClimateStale: boolean,
): RuleBars {
  switch (rule.kind) {
    case 'thermostat':
    case 'daylight-thermostat':
      return buildThermostatBars(rule, climate, isClimateStale);
    case 'co2-burner':
      return buildCo2BurnerBars(rule, climate, isClimateStale);
    default:
      throw new Error(
        `unknown rule kind "${String((rule as { kind?: unknown }).kind)}"`,
      );
  }
}

function buildThermostatBars(
  rule: ThermostatRule | DaylightThermostatRule,
  climate: ClimateSample | null,
  isClimateStale: boolean,
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
        isReadingStale: isClimateStale,
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
  isClimateStale: boolean,
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
        isReadingStale: isClimateStale,
      }),
    ],
    notes: [
      `Day: off at or above ${rule.dayOffAtC} °C, whatever the CO₂.`,
      `Night: a heater - on below ${rule.nightOnBelowC} °C, CO₂ ignored.`,
    ],
  };
}

export function buildThresholdBar(definition: BarDefinition): ThresholdBar {
  assertThresholdsAreNumbers(definition);
  const barWindow = buildWindow(definition);
  const readingText = describeReading(definition);
  return {
    caption: definition.caption,
    segments: buildSegments(barWindow, definition.onSide),
    labels: buildThresholdLabels(barWindow, definition.scale),
    readingText,
    marker: placeMarker(definition, barWindow),
    screenReaderText: describeBar(definition, readingText),
  };
}

function assertThresholdsAreNumbers(definition: BarDefinition): void {
  if (!Number.isFinite(definition.onAt) || !Number.isFinite(definition.offAt)) {
    throw new Error(`${definition.caption} thresholds are not numbers`);
  }
}

function buildWindow(definition: BarDefinition): BarWindow {
  const low = Math.min(definition.onAt, definition.offAt);
  const high = Math.max(definition.onAt, definition.offAt);
  // Sized from the thresholds, never the reading, so a rule always draws the same bar.
  const padding = Math.max(
    definition.scale.minimumPadding,
    (high - low) * PADDING_PER_BAND_WIDTH,
  );
  const minimum = low - padding;
  const maximum = high + padding;
  const toPercent = (value: number): number =>
    ((value - minimum) / (maximum - minimum)) * FULL_SCALE_PERCENT;
  return {
    low,
    high,
    lowPercent: toPercent(low),
    highPercent: toPercent(high),
    minimum,
    maximum,
    toPercent,
  };
}

function buildSegments(barWindow: BarWindow, onSide: BarSide): BarSegment[] {
  const { lowPercent, highPercent } = barWindow;
  const { belowBand, aboveBand } = SIDE_LAYOUTS[onSide];
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
      widthPercent: FULL_SCALE_PERCENT - highPercent,
    },
  ];
}

function buildThresholdLabels(
  barWindow: BarWindow,
  scale: BarScale,
): BarLabel[] {
  const { lowPercent, highPercent } = barWindow;
  const areLabelsCrowded =
    highPercent - lowPercent < MERGE_LABELS_CLOSER_THAN_PERCENT;
  if (areLabelsCrowded) {
    return [
      {
        atPercent: (lowPercent + highPercent) / 2,
        text: `${barWindow.low.toFixed(scale.decimals)}–${formatValue(barWindow.high, scale)}`,
      },
    ];
  }
  return [
    { atPercent: lowPercent, text: formatValue(barWindow.low, scale) },
    { atPercent: highPercent, text: formatValue(barWindow.high, scale) },
  ];
}

function placeMarker(
  definition: BarDefinition,
  barWindow: BarWindow,
): BarMarker | null {
  const { reading, isReadingStale: isStale } = definition;
  if (reading === null) return null;
  if (reading < barWindow.minimum) {
    return { atPercent: 0, offScale: 'low', isStale };
  }
  if (reading > barWindow.maximum) {
    return { atPercent: FULL_SCALE_PERCENT, offScale: 'high', isStale };
  }
  return { atPercent: barWindow.toPercent(reading), offScale: null, isStale };
}

function describeReading(definition: BarDefinition): string {
  if (definition.reading === null) return 'no reading';
  const value = formatValue(definition.reading, definition.scale);
  return definition.isReadingStale ? `last ${value} (stale)` : `now ${value}`;
}

function describeBar(definition: BarDefinition, readingText: string): string {
  const { onDirection, offDirection } = SIDE_LAYOUTS[definition.onSide];
  return (
    `${definition.caption}: on ${onDirection} ${formatValue(definition.onAt, definition.scale)}, ` +
    `off ${offDirection} ${formatValue(definition.offAt, definition.scale)}, holding in between; ${readingText}.`
  );
}

function formatValue(value: number, scale: BarScale): string {
  return `${value.toFixed(scale.decimals)}${scale.unit}`;
}
