import { describe, expect, it } from 'vitest';
import { DeviceRole, type RoleRule, type Zone } from '@tempestas/domain';
import {
  GREENHOUSE,
  NOW,
  PUMPHOUSE,
  device,
  node,
  probe,
  pumphouseEvaluation,
} from './zone-fixtures';
import {
  decisionTone,
  deviceLine,
  formatDuration,
  policyText,
  thresholdBar,
  zoneCards,
  type ZonesInput,
} from './zone-view';

function input(over: Partial<ZonesInput> = {}): ZonesInput {
  return {
    zones: [PUMPHOUSE],
    evaluations: [pumphouseEvaluation()],
    failures: [],
    nodes: [node('patji', 'z-pump')],
    readings: [probe('pipes', 17.5), probe('air', 19.4)],
    devices: [device()],
    now: NOW.getTime(),
    ...over,
  };
}

describe('thresholdBar', () => {
  const heat = (value: number | null) =>
    thresholdBar({
      caption: 'Temperature',
      unit: ' °C',
      onSide: 'low',
      onAt: 2,
      offAt: 5,
      value,
      minPad: 3,
      decimals: 1,
    });

  // The dead band is the part people ask about: on below 2, off above 5, and
  // between them it holds whatever it was doing.
  it('draws on below the on point, the dead band, then off above the off point', () => {
    const bar = heat(3.5);
    expect(bar.segments.map((s) => s.kind)).toEqual(['on', 'band', 'off']);
    const [on, band, off] = bar.segments;
    expect(on.from).toBe(0);
    expect(band.from).toBeCloseTo(on.width);
    expect(off.from + off.width).toBeCloseTo(100);
    // 3.5 is the middle of the band, and the band is the middle of the bar.
    expect(bar.marker?.pct).toBeCloseTo(50);
  });

  // Stretching the scale to reach 19.4 crushed 2-5 °C into a corner of the
  // bar, on the live pumphouse. The scale stays put; the reading pins to the
  // edge and is said in words instead.
  it('pins a reading beyond the scale to its edge rather than stretching', () => {
    const bar = heat(19.4);
    expect(bar.marker).toEqual({ pct: 100, offScale: 'high' });
    expect(bar.now).toBe('now 19.4 °C');
    expect(bar.labels.map((l) => l.text)).toEqual(['2.0 °C', '5.0 °C']);
    expect(heat(-30).marker).toEqual({ pct: 0, offScale: 'low' });
  });

  it('draws the same scale whatever the reading', () => {
    expect(heat(3).segments).toEqual(heat(19.4).segments);
  });

  it('puts the on side on the right for a cooling rule', () => {
    const bar = thresholdBar({
      caption: 'Temperature',
      unit: ' °C',
      onSide: 'high',
      onAt: 30,
      offAt: 29.5,
      value: null,
      minPad: 3,
      decimals: 1,
    });
    expect(bar.segments.map((s) => s.kind)).toEqual(['off', 'band', 'on']);
    expect(bar.marker).toBeNull();
    expect(bar.now).toBe('no reading');
    // 29.5 and 30 would print on top of each other.
    expect(bar.labels.map((l) => l.text)).toEqual(['29.5–30.0 °C']);
    expect(bar.description).toContain('on above 30.0 °C');
    expect(bar.description).toContain('no reading');
  });

  it('says the whole picture in a sentence for a screen reader', () => {
    expect(heat(17.5).description).toBe(
      'Temperature: on below 2.0 °C, off above 5.0 °C, holding in between; now 17.5 °C.',
    );
  });
});

describe('zoneCards', () => {
  it('builds the pumphouse as it is', () => {
    const [card] = zoneCards(input());
    expect(card.name).toBe('Pumphouse');
    expect(card.localTime).toBe('14:14');
    expect(card.evaluatedAgoS).toBe(3);
    expect(card.policy).toBe(
      'Controls on the coldest probe · stale after 2 min',
    );
    expect(card.rules.map((r) => r.label)).toEqual(['Heater', 'Heat tape']);
    expect(card.rules[0].decision).toEqual({
      headline: 'OFF · above setpoint',
      tone: 'off',
    });
    expect(card.rules[0].stale).toBe('If its sensors go quiet: turn ON.');
    expect(card.daylight).toBeNull();
  });

  // `min` takes the coldest probe. The resolver says which probes took part,
  // not which won, so the winner is the one matching the resolved value.
  it('marks the probe that is controlling', () => {
    const [card] = zoneCards(input());
    expect(card.probes.map((p) => [p.label, p.tag])).toEqual([
      ['air', null],
      ['pipes', 'controlling'],
    ]);
  });

  it('flags a probe that has gone quiet', () => {
    const [card] = zoneCards(input({ readings: [probe('pipes', 17.5, 600)] }));
    expect(card.probes[0]).toMatchObject({ quiet: true, ageS: 600 });
  });

  it('ignores probes on nodes in other zones', () => {
    const [card] = zoneCards(input({ nodes: [node('patji', 'z-green')] }));
    expect(card.probes).toEqual([]);
  });

  it('attaches each device to its rule with what it did with the decision', () => {
    const [card] = zoneCards(input());
    expect(card.rules[0].devices).toEqual([
      expect.objectContaining({
        name: 'Heater',
        where: 'patji · BCM5',
        isOn: false,
        manual: false,
        outcome: 'where the rule wants it',
      }),
    ]);
    expect(card.rules[1].devices).toEqual([]);
  });

  // A zone that is not being evaluated is a heater nobody is controlling. It
  // must say so on the card, not only in /api/health.
  it('carries a failure from the rules cycle onto the card', () => {
    const [card] = zoneCards(
      input({
        evaluations: [],
        failures: [{ zoneSlug: 'pumphouse', reason: 'invalid rules_config' }],
      }),
    );
    expect(card.failure).toBe('invalid rules_config');
    expect(card.evaluatedAgoS).toBeNull();
    expect(card.rules[0].decision).toBeNull();
  });

  it('shows the greenhouse rules it keeps for roles another controller drives, after the owned one', () => {
    const [card] = zoneCards(input({ zones: [GREENHOUSE], evaluations: [] }));
    expect(card.rules.map((r) => [r.role, r.owned])).toEqual([
      [DeviceRole.Co2Generator, true],
      [DeviceRole.Lights, false],
      [DeviceRole.ExhaustFan, false],
    ]);
    expect(card.rules[0].bars[0].caption).toBe('CO₂ (day)');
    expect(card.rules[0].notes).toEqual([
      'Day: off at or above 28 °C, whatever the CO₂.',
      'Night: a heater - on below 3 °C, CO₂ ignored.',
    ]);
    expect(card.daylight).toEqual({ start: 390, end: 1110, now: null });
  });
});

describe('deviceLine', () => {
  it('counts a cooldown down from the device, not from the decision', () => {
    const line = deviceLine(
      device({
        canTurnOn: false,
        canTurnOnAt: new Date(NOW.getTime() + 192_000).toISOString(),
      }),
      undefined,
      NOW.getTime(),
    );
    expect(line.cooldownS).toBe(192);
    expect(line.outcome).toBeNull();
  });

  it('marks a device with automation off as manual', () => {
    expect(
      deviceLine(device({ rulesEnabled: false }), undefined, NOW.getTime())
        .manual,
    ).toBe(true);
  });

  it('says why a dispatch failed', () => {
    const line = deviceLine(
      device(),
      {
        deviceId: 'd-heater',
        deviceName: 'Heater',
        outcome: 'failed',
        detail: 'NODE_OFFLINE',
      },
      NOW.getTime(),
    );
    expect(line).toMatchObject({
      failed: true,
      outcome: 'FAILED: NODE_OFFLINE',
    });
  });
});

describe('the words', () => {
  it('raises a stale or sensorless decision as a warning, not as on/off', () => {
    const base = pumphouseEvaluation().decisions[0];
    expect(
      decisionTone({ ...base, desired: 'on', reason: 'stale-failsafe' }),
    ).toBe('warn');
    expect(
      decisionTone({ ...base, desired: 'noop', reason: 'no-sensor' }),
    ).toBe('warn');
    expect(
      decisionTone({ ...base, desired: 'noop', reason: 'dead-band' }),
    ).toBe('hold');
    expect(
      decisionTone({ ...base, desired: 'on', reason: 'temp-below-setpoint' }),
    ).toBe('on');
  });

  it('names every sensor source in words', () => {
    expect(policyText({ source: 'mean' })).toBe(
      'Controls on the average of every probe',
    );
    expect(policyText({ source: 'node:patji' })).toBe(
      'Controls on the probes on patji',
    );
    expect(policyText({ source: 'sensor:patji/pipes', maxAgeMs: 90_000 })).toBe(
      'Controls on patji/pipes only · stale after 1:30',
    );
  });

  it('formats durations for a countdown', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(192)).toBe('3:12');
    expect(formatDuration(3_900)).toBe('1 h 5 min');
  });
});

// A hand-edited zone this page cannot draw must cost that zone - and only the
// part of it that is broken - never the whole page: the card's failure alert
// is exactly what a broken zone most needs shown.
describe('zoneCards with a config it cannot draw', () => {
  const withRules = (rules: Record<string, unknown>, extra = {}): Zone => ({
    ...PUMPHOUSE,
    rulesConfig: {
      ...PUMPHOUSE.rulesConfig,
      ...extra,
      rules: { ...PUMPHOUSE.rulesConfig.rules, ...rules },
    } as Zone['rulesConfig'],
  });

  it('keeps the other rules when one has a kind it does not know', () => {
    const zone = withRules({ heater: { kind: 'pid', onStale: 'on' } });
    const [card] = zoneCards(input({ zones: [zone] }));
    const [heater, tape] = card.rules;
    expect(heater.problem).toBe(
      'This rule cannot be drawn: unknown rule kind "pid".',
    );
    expect(heater.bars).toEqual([]);
    expect(heater.devices).toHaveLength(1);
    expect(tape.problem).toBeNull();
    expect(tape.bars).toHaveLength(1);
  });

  it('refuses to draw a bar with a missing threshold', () => {
    const zone = withRules({
      heat_tape: { kind: 'thermostat', mode: 'heat', onAtC: 4, onStale: 'on' },
    });
    const [card] = zoneCards(input({ zones: [zone] }));
    expect(card.rules[1].problem).toBe(
      'This rule cannot be drawn: Temperature thresholds are not numbers.',
    );
  });

  it('names a daylight window that is not HH:MM instead of drawing NaN', () => {
    const zone = withRules({}, { daylight: { start: '7:00am', end: '18:30' } });
    const [card] = zoneCards(input({ zones: [zone] }));
    expect(card.daylight).toBeNull();
    expect(card.problems).toEqual([
      'daylight window "7:00am"–"18:30" is not HH:MM',
    ]);
  });

  it('still renders a card, with the failure, when the whole config is unusable', () => {
    const zone = { ...PUMPHOUSE, rulesConfig: null } as unknown as Zone;
    const cards = zoneCards(
      input({
        zones: [zone, GREENHOUSE],
        evaluations: [],
        failures: [{ zoneSlug: 'pumphouse', reason: 'invalid rules_config' }],
      }),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].failure).toBe('invalid rules_config');
    expect(cards[0].problems[0]).toMatch(/^this zone's config cannot be drawn/);
    expect(cards[1].rules.length).toBeGreaterThan(0);
  });
});

describe('zoneCards honesty', () => {
  // heat_tape's probe went stale, so it has no climate this cycle. Its bar
  // must say so, not borrow the heater's reading and look healthy.
  it("never shows another role's reading on a rule with none of its own", () => {
    const evaluation = pumphouseEvaluation();
    delete evaluation.climateByRole.heat_tape;
    const [card] = zoneCards(input({ evaluations: [evaluation] }));
    expect(card.rules[0].bars[0].now).toBe('now 17.5 °C');
    expect(card.rules[1].bars[0].now).toBe('no reading');
    expect(card.rules[1].bars[0].marker).toBeNull();
  });

  it('drops the last good evaluation of a zone that failed this cycle', () => {
    const [card] = zoneCards(
      input({ failures: [{ zoneSlug: 'pumphouse', reason: 'boom' }] }),
    );
    expect(card.evaluatedAgoS).toBeNull();
    expect(card.rules[0].decision).toBeNull();
  });

  it('flags an evaluation that has not been refreshed for a minute', () => {
    const old = pumphouseEvaluation({
      evaluatedAt: new Date(NOW.getTime() - 61_000).toISOString(),
    });
    expect(zoneCards(input({ evaluations: [old] }))[0].evaluationOld).toBe(
      true,
    );
    expect(zoneCards(input())[0].evaluationOld).toBe(false);
  });

  // The zone default is `min`, but a role may run on one sensor of its own.
  // The tag follows each role's actual policy.
  it('tags probes per role when a role overrides the zone policy', () => {
    const zone: Zone = {
      ...PUMPHOUSE,
      rulesConfig: {
        ...PUMPHOUSE.rulesConfig,
        rules: {
          ...PUMPHOUSE.rulesConfig.rules,
          heat_tape: {
            ...(PUMPHOUSE.rulesConfig.rules.heat_tape as RoleRule),
            sensor: { source: 'sensor:patji/air' },
          } as RoleRule,
        },
      },
    };
    const evaluation = pumphouseEvaluation();
    evaluation.climateByRole.heat_tape = {
      ...evaluation.climateByRole.heater!,
      temperatureC: 19.4,
      sourceSensorIds: ['patji/air'],
    };
    const [card] = zoneCards(
      input({ zones: [zone], evaluations: [evaluation] }),
    );
    expect(card.probes.map((p) => [p.label, p.tag])).toEqual([
      ['air', 'controls Heat tape'],
      ['pipes', 'controls Heater'],
    ]);
  });
});
