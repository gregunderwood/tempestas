import { TestBed } from '@angular/core/testing';
import { Component, signal } from '@angular/core';
import { GAUGE_METRICS, type GaugeMetricKey } from '@tempestas/domain';
import { Gauge } from './gauge';

@Component({
  imports: [Gauge],
  template: `<temp-gauge [metricKey]="key()" [value]="value()" />`,
})
class Host {
  readonly key = signal<GaugeMetricKey>('co2');
  readonly value = signal<number | null>(0);
}

function render(key: GaugeMetricKey, value: number | null): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.key.set(key);
  fixture.componentInstance.value.set(value);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function colorOf(key: GaugeMetricKey, value: number | null): string {
  const figure = render(key, value).querySelector<HTMLElement>('.gauge');
  return figure?.style.getPropertyValue('--gauge-color') ?? '';
}

describe('Gauge', () => {
  // A null CO2 means the sensor had no answer. Rendering 0 reads as
  // "extremely low", which is the one direction that runs the burner - so this
  // is a safety assertion, not a formatting one.
  it('renders a null value as an em-dash, never a zero', () => {
    const el = render('co2', null);
    const number = el.querySelector('.gauge__number');
    expect(number?.textContent?.trim()).toBe('—');
    expect(el.textContent).not.toContain('0');
  });

  it('says "unknown" in words, so the state does not rely on colour', () => {
    expect(render('co2', null).textContent).toContain('unknown');
    expect(render('co2', 500).textContent).not.toContain('unknown');
  });

  it('draws no value arc at all when the value is unknown', () => {
    expect(render('co2', null).querySelector('.gauge__value')).toBeNull();
    expect(render('co2', 500).querySelector('.gauge__value')).not.toBeNull();
  });

  it("formats to the metric's own decimals", () => {
    expect(
      render('temperature', 23.73).querySelector('.gauge__number')?.textContent,
    ).toContain('23.7');
    expect(
      render('co2', 861.4).querySelector('.gauge__number')?.textContent,
    ).toContain('861');
  });

  // The bands are carried over from the old app and have to match AT THE
  // BOUNDARY, which is where an off-by-one shows up. Each `from` is inclusive,
  // so a value exactly on it takes the new colour.
  describe('band colours at boundary values', () => {
    const cases: [GaugeMetricKey, number, string][] = [
      ['co2', 299, 'blue'],
      ['co2', 300, 'green'],
      ['co2', 1749, 'green'],
      ['co2', 1750, 'orange'],
      ['co2', 2200, 'red'],
      ['temperature', 1.9, 'blue'],
      ['temperature', 2, 'purple'],
      ['temperature', 10, 'green'],
      ['temperature', 34.9, 'green'],
      ['temperature', 35, 'orange'],
      ['temperature', 40, 'red'],
      // Humidity is non-monotonic: red at both ends, green in the middle.
      ['humidity', 9.9, 'red'],
      ['humidity', 10, 'orange'],
      ['humidity', 25, 'green'],
      ['humidity', 59.9, 'green'],
      ['humidity', 60, 'orange'],
      ['humidity', 85, 'red'],
    ];

    it.each(cases)('%s at %s is %s', (key, value, expected) => {
      expect(colorOf(key, value)).toBe(`var(--temp-gauge-${expected})`);
    });
  });

  // A sensor reporting outside the configured range must not draw an arc past
  // the end of the track, and must not invert it below the start.
  it('clamps the arc rather than overflowing the track', () => {
    const over = render('co2', 99_999).querySelector('.gauge__value');
    expect(Number(over?.getAttribute('stroke-dashoffset'))).toBe(0);

    const under = render('temperature', -40).querySelector('.gauge__value');
    const length = Number(under?.getAttribute('stroke-dasharray'));
    expect(Number(under?.getAttribute('stroke-dashoffset'))).toBe(length);
  });

  it('labels itself for a screen reader, including when unknown', () => {
    expect(
      render('temperature', 23.7)
        .querySelector('svg')
        ?.getAttribute('aria-label'),
    ).toBe('Temperature 23.7 °C');
    expect(
      render('co2', null).querySelector('svg')?.getAttribute('aria-label'),
    ).toBe('CO2 unknown');
  });

  // The gauge must not carry its own copy of the ranges: the rules engine and
  // this component have to agree about what a band means.
  it('takes its range and unit from the shared contract', () => {
    const el = render('humidity', 50);
    expect(el.textContent).toContain(GAUGE_METRICS.humidity.unit);
    expect(el.textContent).toContain(GAUGE_METRICS.humidity.label);
  });
});
