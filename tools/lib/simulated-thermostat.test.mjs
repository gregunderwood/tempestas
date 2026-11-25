import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  buildSourceTemperature,
  chooseFailingRole,
  FAULT_NIGHT_DAYS_AGO,
  findFaultNight,
  findHeatThermostat,
  simulateThermostatRuns,
} from './simulated-thermostat.mjs';

const TIMEZONE = 'America/Vancouver';
const NOW = new Date('2026-11-23T20:30:00Z');
const MILLISECONDS_PER_MINUTE = 60_000;
const START_MS = Date.parse('2026-11-01T00:00:00Z');
const THERMOSTAT = { onAtC: 4, offAtC: 6, source: 'min' };
const PUMPHOUSE_RULES = {
  enabledRoles: ['heater', 'heat_tape'],
  sensorPolicy: { default: { source: 'min', maxAgeMs: 120000 } },
  rules: {
    heat_tape: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 4,
      offAtC: 6,
      onStale: 'on',
    },
    heater: {
      kind: 'thermostat',
      mode: 'heat',
      onAtC: 2,
      offAtC: 5,
      onStale: 'on',
      sensor: { source: 'node:patji' },
    },
  },
};

function minutesAfterStart(minutes) {
  return START_MS + minutes * MILLISECONDS_PER_MINUTE;
}

// One temperature a minute from START_MS, held at its last value after the list ends.
function temperaturesFrom(temperatures) {
  return (atMs) => {
    const index = Math.round((atMs - START_MS) / MILLISECONDS_PER_MINUTE);
    return temperatures[Math.min(index, temperatures.length - 1)];
  };
}

function runsFor(temperatures, overrides = {}) {
  return simulateThermostatRuns({
    thermostat: THERMOSTAT,
    temperatureAt: temperaturesFrom(temperatures),
    onDelaySeconds: 0,
    fromMs: START_MS,
    untilMs: minutesAfterStart(temperatures.length),
    ...overrides,
  }).map((run) => ({
    fromMinute: (run.fromMs - START_MS) / MILLISECONDS_PER_MINUTE,
    toMinute: (run.toMs - START_MS) / MILLISECONDS_PER_MINUTE,
  }));
}

function probeClimate(nodeId, sensorId, temperatures) {
  return {
    probe: {
      nodeId,
      sensorId,
      firstRealReading: { at: new Date(), temperature: temperatures.at(-1) },
    },
    historyStart: new Date(START_MS),
    minutes: temperatures.map((temperature) => ({ temperature })),
  };
}

describe('simulateThermostatRuns', () => {
  it('comes on only once the temperature is below the on-setpoint', () => {
    assert.deepEqual(runsFor([5, 4, 3.99, 3]), [
      { fromMinute: 2, toMinute: 4 },
    ]);
  });

  it('stays on through the dead band and goes off only above the off point', () => {
    assert.deepEqual(runsFor([3, 5, 6, 6.01, 5]), [
      { fromMinute: 0, toMinute: 3 },
    ]);
  });

  it('waits out the on delay after going off before it comes on again', () => {
    const temperatures = [3, 7, 3, 3, 3, 3, 3, 3];
    assert.deepEqual(runsFor(temperatures, { onDelaySeconds: 300 }), [
      { fromMinute: 0, toMinute: 1 },
      { fromMinute: 6, toMinute: 8 },
    ]);
  });

  it('does not come on while failing, and goes off when the failure starts', () => {
    const failingFromMinuteTwoToFour = (atMs) =>
      atMs >= minutesAfterStart(2) && atMs < minutesAfterStart(4);
    assert.deepEqual(
      runsFor([3, 3, 3, 3, 3, 3], { isFailing: failingFromMinuteTwoToFour }),
      [
        { fromMinute: 0, toMinute: 2 },
        { fromMinute: 4, toMinute: 6 },
      ],
    );
  });

  it('holds its state through a minute with no reading', () => {
    assert.deepEqual(runsFor([3, null, 7]), [{ fromMinute: 0, toMinute: 2 }]);
  });
});

describe('buildSourceTemperature', () => {
  const climates = [
    probeClimate('patji', 'pipes', [1, 2]),
    probeClimate('patji', 'air', [3, 4]),
    probeClimate('elantris', 'air', [8, 9]),
  ];

  for (const [source, expected] of [
    ['min', 1],
    ['max', 8],
    ['mean', 4],
    ['node:patji', 2],
    ['sensor:patji/air', 3],
  ]) {
    it(`reads ${source} as the climate resolver would`, () => {
      assert.equal(
        buildSourceTemperature(climates, source)(START_MS),
        expected,
      );
    });
  }

  it('holds each probe at its first real reading after its seed ends', () => {
    const temperatureAt = buildSourceTemperature(climates, 'min');
    assert.equal(temperatureAt(minutesAfterStart(60)), 2);
  });

  it('is null when no probe is in the source', () => {
    assert.equal(
      buildSourceTemperature(climates, 'node:braize')(START_MS),
      null,
    );
  });
});

describe('findHeatThermostat', () => {
  it("takes the role's setpoints and its own sensor source", () => {
    assert.deepEqual(findHeatThermostat(PUMPHOUSE_RULES, 'heater'), {
      onAtC: 2,
      offAtC: 5,
      source: 'node:patji',
    });
  });

  it("falls back to the zone's default sensor source", () => {
    assert.equal(
      findHeatThermostat(PUMPHOUSE_RULES, 'heat_tape').source,
      'min',
    );
  });

  it('follows nothing for a role with no heat thermostat', () => {
    const greenhouse = {
      enabledRoles: ['exhaust_fan', 'heater'],
      rules: {
        exhaust_fan: {
          kind: 'thermostat',
          mode: 'cool',
          onAtC: 30,
          offAtC: 29,
        },
        heater: {
          kind: 'daylight-thermostat',
          mode: 'heat',
          onAtC: 2,
          offAtC: 5,
        },
      },
    };
    assert.equal(findHeatThermostat(greenhouse, 'exhaust_fan'), null);
    assert.equal(findHeatThermostat(greenhouse, 'heater'), null);
    assert.equal(findHeatThermostat(null, 'heater'), null);
  });

  it('follows nothing for a role the rules do not own', () => {
    const heaterOnly = { ...PUMPHOUSE_RULES, enabledRoles: ['heater'] };
    assert.equal(findHeatThermostat(heaterOnly, 'heat_tape'), null);
    assert.notEqual(findHeatThermostat(heaterOnly, 'heater'), null);
  });
});

describe('chooseFailingRole', () => {
  it('fails the heat tape when the zone has one, so its heater still comes on', () => {
    assert.equal(chooseFailingRole(['heater', 'heat_tape']), 'heat_tape');
  });

  it('fails the heater in a zone with no heat tape following a thermostat', () => {
    assert.equal(chooseFailingRole(['heater']), 'heater');
  });

  it('fails nothing in a zone with no line following a thermostat', () => {
    assert.equal(chooseFailingRole([]), null);
  });
});

describe('findFaultNight', () => {
  it(`runs from 20:00 to 07:00 local, the night ${FAULT_NIGHT_DAYS_AGO} days ago`, () => {
    const faultNight = findFaultNight(NOW, TIMEZONE);
    const from = DateTime.fromMillis(faultNight.fromMs, { zone: TIMEZONE });
    const to = DateTime.fromMillis(faultNight.toMs, { zone: TIMEZONE });
    assert.equal(from.toFormat('yyyy-MM-dd HH:mm'), '2026-11-06 20:00');
    assert.equal(to.toFormat('yyyy-MM-dd HH:mm'), '2026-11-07 07:00');
  });
});
