import { describe, expect, it } from 'vitest';
import {
  TEMPERATURE_SCALE,
  buildThresholdBar,
  type BarDefinition,
  type ThresholdBar,
} from './threshold-bar';

const HEATER: Omit<BarDefinition, 'reading'> = {
  caption: 'Temperature',
  scale: TEMPERATURE_SCALE,
  onSide: 'low',
  onAt: 2,
  offAt: 5,
  isReadingStale: false,
};

const heaterBarAt = (reading: number | null): ThresholdBar =>
  buildThresholdBar({ ...HEATER, reading });

const kindsOf = (bar: ThresholdBar): string[] =>
  bar.segments.map((segment) => segment.kind);

const labelTextsOf = (bar: ThresholdBar): string[] =>
  bar.labels.map((label) => label.text);

describe('buildThresholdBar', () => {
  it('draws on below the on point, the dead band, then off above the off point', () => {
    const bar = heaterBarAt(3.5);
    expect(kindsOf(bar)).toEqual(['on', 'band', 'off']);
    const [onSegment, band, offSegment] = bar.segments;
    expect(onSegment.fromPercent).toBe(0);
    expect(band.fromPercent).toBeCloseTo(onSegment.widthPercent);
    expect(offSegment.fromPercent + offSegment.widthPercent).toBeCloseTo(100);
    expect(bar.marker?.atPercent).toBeCloseTo(50);
  });

  it('pins a reading beyond the scale to its edge rather than stretching', () => {
    const bar = heaterBarAt(19.4);
    expect(bar.marker).toEqual({
      atPercent: 100,
      offScale: 'high',
      isStale: false,
    });
    expect(bar.readingText).toBe('now 19.4 °C');
    expect(labelTextsOf(bar)).toEqual(['2.0 °C', '5.0 °C']);
    expect(heaterBarAt(-30).marker).toEqual({
      atPercent: 0,
      offScale: 'low',
      isStale: false,
    });
  });

  it('draws the same scale whatever the reading', () => {
    expect(heaterBarAt(3).segments).toEqual(heaterBarAt(19.4).segments);
  });

  it('puts the on side on the right for a cooling rule, and merges crowded labels', () => {
    const bar = buildThresholdBar({
      ...HEATER,
      onSide: 'high',
      onAt: 30,
      offAt: 29.5,
      reading: null,
    });
    expect(kindsOf(bar)).toEqual(['off', 'band', 'on']);
    expect(bar.marker).toBeNull();
    expect(bar.readingText).toBe('no reading');
    expect(labelTextsOf(bar)).toEqual(['29.5–30.0 °C']);
    expect(bar.screenReaderText).toContain('on above 30.0 °C');
  });

  it('says the whole picture in a sentence for a screen reader', () => {
    expect(heaterBarAt(17.5).screenReaderText).toBe(
      'Temperature: on below 2.0 °C, off above 5.0 °C, holding in between; now 17.5 °C.',
    );
  });

  it('calls a reading from sensors that went quiet the last one, not now', () => {
    const bar = buildThresholdBar({
      ...HEATER,
      reading: 17.5,
      isReadingStale: true,
    });
    expect(bar.readingText).toBe('last 17.5 °C (stale)');
    expect(bar.marker?.isStale).toBe(true);
    expect(bar.screenReaderText).toContain('last 17.5 °C (stale)');
  });

  it('refuses thresholds that are not numbers', () => {
    expect(() =>
      buildThresholdBar({ ...HEATER, offAt: Number.NaN, reading: null }),
    ).toThrow('Temperature thresholds are not numbers');
  });
});
