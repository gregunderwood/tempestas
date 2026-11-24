import { describe, expect, it } from 'vitest';
import {
  DeviceRole,
  type ClimateSample,
  type RoleRule,
  type RuleReason,
  type Zone,
} from '@tempestas/domain';
import {
  GREENHOUSE,
  NOW,
  PUMPHOUSE,
  PUMPHOUSE_REFUSED,
  cycleOf,
  device,
  node,
  probe,
  pumphouseEvaluation,
} from './zone-fixtures';
import {
  buildDeviceLine,
  buildZoneCards,
  describeZoneSubtitle,
  type ZoneCard,
  type ZonesInput,
} from './zone-view';

function zonesInput(overrides: Partial<ZonesInput> = {}): ZonesInput {
  return {
    zones: [PUMPHOUSE],
    cycle: cycleOf([pumphouseEvaluation()]),
    nodes: [node('patji', 'z-pump')],
    readings: [probe('pipes', 17.5), probe('air', 19.4)],
    devices: [device()],
    now: NOW.getTime(),
    ...overrides,
  };
}

function onlyCard(overrides: Partial<ZonesInput> = {}): ZoneCard {
  return buildZoneCards(zonesInput(overrides))[0];
}

function zoneWith(
  rules: Record<string, unknown>,
  configOverrides: Record<string, unknown> = {},
): Zone {
  return {
    ...PUMPHOUSE,
    rulesConfig: {
      ...PUMPHOUSE.rulesConfig,
      ...configOverrides,
      rules: { ...PUMPHOUSE.rulesConfig.rules, ...rules },
    } as Zone['rulesConfig'],
  };
}

const MINUTE_AGO = new Date(NOW.getTime() - 61_000).toISOString();

const probeTagsOf = (card: ZoneCard): [string, string | null][] =>
  card.probes.map((probeLine) => [probeLine.label, probeLine.tag]);

describe('buildZoneCards', () => {
  it('builds the pumphouse as it is', () => {
    const card = onlyCard();
    expect(card.name).toBe('Pumphouse');
    expect(card.localTime).toBe('14:14');
    expect(card.rulesRanAgoSeconds).toBe(3);
    expect(card.policy).toBe(
      'Controls on the coldest probe · stale after 2 min',
    );
    expect(card.rules.map((rule) => rule.label)).toEqual([
      'Heater',
      'Heat tape',
    ]);
    expect(card.rules[0].decision).toEqual({
      headline: 'OFF · above setpoint',
      tone: 'off',
    });
    expect(card.rules[0].stalePolicy).toBe('If its sensors go quiet: turn ON.');
    expect(card.daylight).toBeNull();
  });

  it('marks the probe that is controlling', () => {
    expect(probeTagsOf(onlyCard())).toEqual([
      ['air', null],
      ['pipes', 'controlling'],
    ]);
  });

  it('flags a probe that has gone quiet', () => {
    const card = onlyCard({ readings: [probe('pipes', 17.5, 600)] });
    expect(card.probes[0]).toMatchObject({ isQuiet: true, ageSeconds: 600 });
  });

  it('ignores probes on nodes in other zones', () => {
    expect(onlyCard({ nodes: [node('patji', 'z-green')] }).probes).toEqual([]);
  });

  it('attaches each device to its rule with what it did with the decision', () => {
    const card = onlyCard();
    expect(card.rules[0].devices).toEqual([
      expect.objectContaining({
        name: 'Heater',
        where: 'patji · BCM5',
        isOn: false,
        isManual: false,
        outcome: 'where the rule wants it',
      }),
    ]);
    expect(card.rules[1].devices).toEqual([]);
  });

  it('carries a failure from the rules cycle onto the card, aged from that cycle', () => {
    const minuteOldRefusal = { ...PUMPHOUSE_REFUSED, at: MINUTE_AGO };
    const card = onlyCard({ cycle: minuteOldRefusal });
    expect(card.failure).toBe('invalid rules_config');
    expect(card.rulesRanAgoSeconds).toBe(61);
    expect(card.isRulesRunOld).toBe(true);
    expect(card.rules[0].decision).toBeNull();
  });

  it('shows the rules kept for roles another controller drives, after the owned one', () => {
    const card = onlyCard({ zones: [GREENHOUSE], cycle: cycleOf([]) });
    expect(card.rules.map((rule) => [rule.role, rule.isOwned])).toEqual([
      [DeviceRole.Co2Generator, true],
      [DeviceRole.Lights, false],
      [DeviceRole.ExhaustFan, false],
    ]);
    expect(card.rules[0].bars[0].caption).toBe('CO₂ (day)');
    expect(card.rules[0].notes).toEqual([
      'Day: off at or above 28 °C, whatever the CO₂.',
      'Night: a heater - on below 3 °C, CO₂ ignored.',
    ]);
    expect(card.daylight).toEqual({
      windowLabel: '06:30–18:30',
      segments: [{ fromPercent: 27.083333333333332, widthPercent: 50 }],
      nowPercent: null,
      screenReaderText: 'Daylight 06:30–18:30',
    });
  });

  it('tells a screen reader where now falls in the daylight window', () => {
    const zone = zoneWith({}, { daylight: { start: '06:30', end: '18:30' } });
    expect(onlyCard({ zones: [zone] }).daylight?.screenReaderText).toBe(
      'Daylight 06:30–18:30, now 14:14',
    );
  });

  it('draws a daylight window that crosses midnight as two segments', () => {
    const zone = zoneWith({}, { daylight: { start: '22:00', end: '02:00' } });
    expect(onlyCard({ zones: [zone] }).daylight?.segments).toHaveLength(2);
  });
});

describe('buildZoneCards with a config it cannot draw', () => {
  it('keeps the other rules when one has a kind it does not know', () => {
    const zone = zoneWith({ heater: { kind: 'pid', onStale: 'on' } });
    const [heater, heatTape] = onlyCard({ zones: [zone] }).rules;
    expect(heater.problem).toBe(
      'This rule cannot be drawn: unknown rule kind "pid".',
    );
    expect(heater.bars).toEqual([]);
    expect(heater.devices).toHaveLength(1);
    expect(heatTape.problem).toBeNull();
    expect(heatTape.bars).toHaveLength(1);
  });

  it('refuses to draw a bar with a missing threshold', () => {
    const zone = zoneWith({
      heat_tape: { kind: 'thermostat', mode: 'heat', onAtC: 4, onStale: 'on' },
    });
    expect(onlyCard({ zones: [zone] }).rules[1].problem).toBe(
      'This rule cannot be drawn: Temperature thresholds are not numbers.',
    );
  });

  it('names a daylight window that is not HH:MM instead of drawing NaN', () => {
    const zone = zoneWith({}, { daylight: { start: '7:00am', end: '18:30' } });
    const card = onlyCard({ zones: [zone] });
    expect(card.daylight).toBeNull();
    expect(card.problems).toEqual([
      'daylight window "7:00am"–"18:30" is not HH:MM',
    ]);
  });

  it('still renders a card, with the failure, when the whole config is unusable', () => {
    const zone = { ...PUMPHOUSE, rulesConfig: null } as unknown as Zone;
    const cards = buildZoneCards(
      zonesInput({ zones: [zone, GREENHOUSE], cycle: PUMPHOUSE_REFUSED }),
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].failure).toBe('invalid rules_config');
    expect(cards[0].problems[0]).toMatch(/^this zone's config cannot be drawn/);
    expect(cards[1].rules.length).toBeGreaterThan(0);
  });
});

describe('buildZoneCards shows nothing that is not true', () => {
  it("never shows another role's reading on a rule with none of its own", () => {
    const evaluation = pumphouseEvaluation();
    delete evaluation.climateByRole.heat_tape;
    const [heater, heatTape] = onlyCard({ cycle: cycleOf([evaluation]) }).rules;
    expect(heater.bars[0].readingText).toBe('now 17.5 °C');
    expect(heatTape.bars[0].readingText).toBe('no reading');
    expect(heatTape.bars[0].marker).toBeNull();
  });

  it('calls the reading of a role whose sensors went quiet the last one, not now', () => {
    const evaluation = pumphouseEvaluation({
      staleRoles: [DeviceRole.HeatTape],
    });
    const [heater, heatTape] = onlyCard({ cycle: cycleOf([evaluation]) }).rules;
    expect(heater.bars[0].readingText).toBe('now 17.5 °C');
    expect(heatTape.bars[0].readingText).toBe('last 17.5 °C (stale)');
    expect(heatTape.bars[0].marker?.isStale).toBe(true);
  });

  it('drops the last good evaluation of a zone that failed this cycle', () => {
    const card = onlyCard({
      cycle: { ...PUMPHOUSE_REFUSED, evaluations: [pumphouseEvaluation()] },
    });
    expect(card.localTime).toBeNull();
    expect(card.rules[0].decision).toBeNull();
  });

  it('flags rules that have not run for a minute', () => {
    const minuteOldEvaluation = pumphouseEvaluation({
      evaluatedAt: MINUTE_AGO,
    });
    expect(
      onlyCard({ cycle: cycleOf([minuteOldEvaluation]) }).isRulesRunOld,
    ).toBe(true);
    expect(onlyCard().isRulesRunOld).toBe(false);
  });

  it('keeps the controlling tag on the probe that decided, whatever it reads now', () => {
    const card = onlyCard({
      readings: [probe('pipes', 19.4), probe('air', 17.5)],
    });
    expect(probeTagsOf(card)).toEqual([
      ['air', null],
      ['pipes', 'controlling'],
    ]);
  });

  it('does not tag a probe as deciding a role whose sensors went quiet', () => {
    const evaluation = pumphouseEvaluation({
      staleRoles: [DeviceRole.HeatTape],
    });
    expect(probeTagsOf(onlyCard({ cycle: cycleOf([evaluation]) }))).toEqual([
      ['air', null],
      ['pipes', 'controls Heater'],
    ]);
  });

  it('does not call a probe controlling when an enabled role has no reading at all', () => {
    const evaluation = pumphouseEvaluation();
    delete evaluation.climateByRole.heat_tape;
    expect(probeTagsOf(onlyCard({ cycle: cycleOf([evaluation]) }))).toEqual([
      ['air', null],
      ['pipes', 'controls Heater'],
    ]);
  });

  it('tags probes per role when a role overrides the zone policy', () => {
    const zone = zoneWith({
      heat_tape: {
        ...(PUMPHOUSE.rulesConfig.rules.heat_tape as RoleRule),
        sensor: { source: 'sensor:patji/air' },
      },
    });
    const evaluation = pumphouseEvaluation();
    evaluation.climateByRole.heat_tape = {
      ...(evaluation.climateByRole.heater as ClimateSample),
      temperatureC: 19.4,
      sourceSensorIds: ['patji/air'],
      decidingSensorIds: ['patji/air'],
    };
    expect(
      probeTagsOf(onlyCard({ zones: [zone], cycle: cycleOf([evaluation]) })),
    ).toEqual([
      ['air', 'controls Heat tape'],
      ['pipes', 'controls Heater'],
    ]);
  });
});

describe('buildZoneCards tags the probe that decided the measurement the rule used', () => {
  const COLD_HIGH_CO2 = 'patji/north';
  const WARM_LOW_CO2 = 'patji/south';

  function greenhouseCard(reason: RuleReason, hasCo2 = true): ZoneCard {
    const evaluation = pumphouseEvaluation({
      zoneId: GREENHOUSE.id,
      zoneSlug: GREENHOUSE.slug,
      enabledRoles: [DeviceRole.Co2Generator],
      climateByRole: {
        co2_generator: {
          temperatureC: 18,
          co2Ppm: hasCo2 ? 600 : null,
          observedAt: NOW.toISOString(),
          sourceNodeIds: ['patji'],
          sourceSensorIds: [COLD_HIGH_CO2, WARM_LOW_CO2],
          decidingSensorIds: [COLD_HIGH_CO2],
          co2DecidingSensorIds: hasCo2 ? [WARM_LOW_CO2] : [],
        },
      },
      decisions: [
        {
          role: DeviceRole.Co2Generator,
          desired: 'noop',
          reason,
          sourceNodeIds: ['patji'],
          dispatched: [],
        },
      ],
    });
    return onlyCard({
      zones: [GREENHOUSE],
      nodes: [node('patji', GREENHOUSE.id)],
      readings: [
        probe('north', 18, 4, hasCo2 ? 900 : null),
        probe('south', 22, 4, hasCo2 ? 600 : null),
      ],
      devices: [],
      cycle: cycleOf([evaluation]),
    });
  }

  function decidingMeasurementsOf(
    card: ZoneCard,
  ): [string, boolean, boolean][] {
    return card.probes.map((probeLine) => [
      probeLine.label,
      probeLine.isTemperatureDeciding,
      probeLine.isCo2Deciding,
    ]);
  }

  it.each<RuleReason>(['co2-below-threshold', 'co2-at-threshold', 'dead-band'])(
    'tags the lowest-CO2 probe when the burner decided on CO2 (%s)',
    (reason) => {
      expect(probeTagsOf(greenhouseCard(reason))).toEqual([
        ['north', null],
        ['south', 'controlling'],
      ]);
    },
  );

  it('tags no probe when the burner decided on CO2 but no probe has any', () => {
    expect(probeTagsOf(greenhouseCard('co2-at-threshold', false))).toEqual([
      ['north', null],
      ['south', null],
    ]);
  });

  it('marks only the CO2 value as deciding when the burner decided on CO2', () => {
    expect(decidingMeasurementsOf(greenhouseCard('dead-band'))).toEqual([
      ['north', false, false],
      ['south', false, true],
    ]);
  });

  it('marks only the temperature as deciding when the burner decided on temperature', () => {
    expect(decidingMeasurementsOf(greenhouseCard('frost-protection'))).toEqual([
      ['north', true, false],
      ['south', false, false],
    ]);
  });

  it.each<RuleReason>(['frost-protection', 'temp-above-setpoint'])(
    'tags the coldest probe when the burner decided on temperature (%s)',
    (reason) => {
      expect(probeTagsOf(greenhouseCard(reason))).toEqual([
        ['north', 'controlling'],
        ['south', null],
      ]);
    },
  );

  it("shows each probe's CO2 beside its temperature", () => {
    expect(
      greenhouseCard('dead-band').probes.map((probeLine) => [
        probeLine.label,
        probeLine.co2Ppm,
      ]),
    ).toEqual([
      ['north', 900],
      ['south', 600],
    ]);
  });

  it('shows no CO2 for a probe that has none', () => {
    expect(onlyCard().probes.map((probeLine) => probeLine.co2Ppm)).toEqual([
      null,
      null,
    ]);
  });
});

describe('buildDeviceLine', () => {
  it('counts a cooldown down from the device, not from the decision', () => {
    const line = buildDeviceLine(
      device({
        canTurnOn: false,
        canTurnOnAt: new Date(NOW.getTime() + 192_000).toISOString(),
      }),
      undefined,
      NOW.getTime(),
    );
    expect(line.cooldownSeconds).toBe(192);
    expect(line.outcome).toBeNull();
  });

  it('marks a device with automation off as manual', () => {
    const line = buildDeviceLine(
      device({ rulesEnabled: false }),
      undefined,
      NOW.getTime(),
    );
    expect(line.isManual).toBe(true);
  });

  it('marks a failed dispatch', () => {
    const line = buildDeviceLine(
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
      hasFailed: true,
      outcome: 'FAILED: NODE_OFFLINE',
    });
  });
});

describe('describeZoneSubtitle', () => {
  const card = {
    localTime: '14:05',
    timezone: 'America/Vancouver',
    rulesRanAgoSeconds: 60,
  } as ZoneCard;

  it('joins the local time and when the rules ran', () => {
    expect(describeZoneSubtitle(card, false)).toBe(
      '14:05 America/Vancouver · rules ran 1 min ago',
    );
  });

  it('says the rules have not run when there is no cycle yet', () => {
    expect(
      describeZoneSubtitle({ ...card, rulesRanAgoSeconds: null }, false),
    ).toBe('14:05 America/Vancouver · rules have not run yet');
  });

  it('leaves the rules out on a follower', () => {
    expect(describeZoneSubtitle(card, true)).toBe('14:05 America/Vancouver');
  });

  it('shows only the rules when the local time is unknown', () => {
    expect(describeZoneSubtitle({ ...card, localTime: null }, false)).toBe(
      'rules ran 1 min ago',
    );
  });
});
