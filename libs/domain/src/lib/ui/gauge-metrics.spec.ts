import { GAUGE_METRICS, gaugeColorFor } from './gauge-metrics';

describe('gaugeColorFor', () => {
  it('picks the last threshold at or below the value', () => {
    expect(gaugeColorFor(GAUGE_METRICS.co2, 250)).toBe('blue');
    expect(gaugeColorFor(GAUGE_METRICS.co2, 300)).toBe('green');
    expect(gaugeColorFor(GAUGE_METRICS.co2, 1749)).toBe('green');
    expect(gaugeColorFor(GAUGE_METRICS.co2, 1750)).toBe('orange');
    expect(gaugeColorFor(GAUGE_METRICS.co2, 2200)).toBe('red');
  });

  it('handles the non-monotonic humidity bands', () => {
    expect(gaugeColorFor(GAUGE_METRICS.humidity, 5)).toBe('red');
    expect(gaugeColorFor(GAUGE_METRICS.humidity, 30)).toBe('green');
    expect(gaugeColorFor(GAUGE_METRICS.humidity, 70)).toBe('orange');
    expect(gaugeColorFor(GAUGE_METRICS.humidity, 90)).toBe('red');
  });

  it('returns null for a null value, which a nullable co2 reading needs', () => {
    expect(gaugeColorFor(GAUGE_METRICS.co2, null)).toBeNull();
  });

  it('covers sub-zero temperature', () => {
    expect(gaugeColorFor(GAUGE_METRICS.temperature, -10)).toBe('blue');
    expect(gaugeColorFor(GAUGE_METRICS.temperature, 2)).toBe('purple');
  });
});
