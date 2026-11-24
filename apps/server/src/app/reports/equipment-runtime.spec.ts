import { DateTime } from 'luxon';
import { DeviceRole, type DeviceRuntime } from '@tempestas/domain';
import {
  summariseEquipmentRuntime,
  type NodeSighting,
  type RuntimeDevice,
  type RuntimeTransition,
} from './equipment-runtime';

const TIMEZONE = 'America/Vancouver';
const NODE_SLUG = 'elantris';
const BURNER_PIN = 17;

const BURNER: RuntimeDevice = {
  id: 'burner-device',
  name: 'CO2 burner',
  role: DeviceRole.Co2Generator,
  nodeId: NODE_SLUG,
  zoneId: 'greenhouse-zone',
  timezone: TIMEZONE,
};

const ONLINE: NodeSighting = { isOnline: true, lastHeardAt: null };

const atLocal = (iso: string): Date =>
  DateTime.fromISO(iso, { zone: TIMEZONE }).toJSDate();

function transition(
  localIso: string,
  energised: boolean | null,
  deviceId: string | null = BURNER.id,
): RuntimeTransition {
  return {
    nodeId: NODE_SLUG,
    pin: BURNER_PIN,
    energised,
    deviceId,
    observedAt: atLocal(localIso),
  };
}

interface Scenario {
  transitions: RuntimeTransition[];
  nowLocal: string;
  days: number;
  sighting?: NodeSighting;
  devices?: RuntimeDevice[];
}

function summarise(scenario: Scenario): DeviceRuntime[] {
  return summariseEquipmentRuntime({
    devices: scenario.devices ?? [BURNER],
    transitions: scenario.transitions,
    sightingsByNode: new Map([[NODE_SLUG, scenario.sighting ?? ONLINE]]),
    days: scenario.days,
    now: atLocal(scenario.nowLocal),
  });
}

function summariseBurner(scenario: Scenario): DeviceRuntime {
  return summarise(scenario)[0];
}

describe('summariseEquipmentRuntime', () => {
  it('lists one day per calendar day, oldest first, ending with today so far', () => {
    const burner = summariseBurner({
      transitions: [transition('2026-09-01T00:00', false)],
      nowLocal: '2026-09-10T06:00',
      days: 3,
    });
    expect(burner.days.map((day) => day.date)).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
    ]);
    expect(burner.days[2].hoursOff).toBe(6);
  });

  it('adds up hours on, starts and the shortest complete run', () => {
    const burner = summariseBurner({
      transitions: [
        transition('2026-09-09T00:00', false),
        transition('2026-09-09T08:00', true),
        transition('2026-09-09T09:30', false),
        transition('2026-09-09T12:00', true),
        transition('2026-09-09T12:04', false),
        transition('2026-09-09T20:00', true),
        transition('2026-09-09T21:00', false),
      ],
      nowLocal: '2026-09-10T00:00',
      days: 2,
    });
    const [ninth] = burner.days;
    expect(ninth).toMatchObject({
      date: '2026-09-09',
      hoursOn: 2.57,
      hoursOff: 21.43,
      hoursUnknown: 0,
      starts: 3,
      shortestRunMinutes: 4,
      hasRunCappedAtLastSeen: false,
    });
    expect(burner.totalStarts).toBe(3);
    expect(burner.totalHoursOn).toBe(2.57);
  });

  it('reads repeated rows of the same state as one run, not a run per row', () => {
    const burner = summariseBurner({
      transitions: [
        transition('2026-09-09T00:00', false),
        transition('2026-09-09T08:00', true),
        transition('2026-09-09T08:30', true),
        transition('2026-09-09T09:00', false),
      ],
      nowLocal: '2026-09-09T12:00',
      days: 1,
    });
    expect(burner.days[0]).toMatchObject({
      hoursOn: 1,
      starts: 1,
      shortestRunMinutes: 60,
    });
  });

  it('accepts transitions in any order', () => {
    const burner = summariseBurner({
      transitions: [
        transition('2026-09-09T09:00', false),
        transition('2026-09-09T08:00', true),
        transition('2026-09-09T00:00', false),
      ],
      nowLocal: '2026-09-09T12:00',
      days: 1,
    });
    expect(burner.days[0]).toMatchObject({ hoursOn: 1, starts: 1 });
  });

  it('carries the state in force before the window into its first day', () => {
    const burner = summariseBurner({
      transitions: [
        transition('2026-08-01T00:00', false),
        transition('2026-09-08T23:00', true),
        transition('2026-09-09T02:00', false),
      ],
      nowLocal: '2026-09-09T12:00',
      days: 1,
    });
    expect(burner.days[0]).toMatchObject({
      hoursOn: 2,
      hoursOff: 10,
      hoursUnknown: 0,
      starts: 0,
    });
  });

  describe('a run that crosses midnight', () => {
    const scenario: Scenario = {
      transitions: [
        transition('2026-09-08T00:00', false),
        transition('2026-09-08T22:00', true),
        transition('2026-09-09T03:00', false),
      ],
      nowLocal: '2026-09-09T12:00',
      days: 2,
    };

    it('splits its hours at the zone midnight', () => {
      const [eighth, ninth] = summariseBurner(scenario).days;
      expect(eighth.hoursOn).toBe(2);
      expect(ninth.hoursOn).toBe(3);
    });

    // Cutting it in two would invent a short run that never happened.
    it('counts as one start, on the day it began, at its whole length', () => {
      const [eighth, ninth] = summariseBurner(scenario).days;
      expect(eighth).toMatchObject({ starts: 1, shortestRunMinutes: 300 });
      expect(ninth).toMatchObject({ starts: 0, shortestRunMinutes: null });
    });

    it('splits at the zone midnight, not UTC midnight', () => {
      const torontoBurner = { ...BURNER, timezone: 'America/Toronto' };
      const [eighth, ninth] = summariseBurner({
        ...scenario,
        devices: [torontoBurner],
      }).days;
      expect(eighth.hoursOn).toBe(0);
      expect(ninth.hoursOn).toBe(5);
    });
  });

  describe('unknown spans', () => {
    it('counts energised = null as unknown, not off', () => {
      const burner = summariseBurner({
        transitions: [
          transition('2026-09-09T00:00', false),
          transition('2026-09-09T06:00', null),
          transition('2026-09-09T10:00', false),
        ],
        nowLocal: '2026-09-09T12:00',
        days: 1,
      });
      expect(burner.days[0]).toMatchObject({
        hoursOff: 8,
        hoursUnknown: 4,
      });
      expect(burner.totalHoursUnknown).toBe(4);
    });

    it('counts the time before any history as unknown', () => {
      const burner = summariseBurner({
        transitions: [transition('2026-09-09T06:00', false)],
        nowLocal: '2026-09-09T12:00',
        days: 2,
      });
      expect(burner.days[0].hoursUnknown).toBe(24);
      expect(burner.days[1]).toMatchObject({ hoursOff: 6, hoursUnknown: 6 });
    });

    it('does not count a node reappearing on as a start', () => {
      const burner = summariseBurner({
        transitions: [
          transition('2026-09-09T00:00', true),
          transition('2026-09-09T02:00', null),
          transition('2026-09-09T03:00', true),
          transition('2026-09-09T04:00', false),
        ],
        nowLocal: '2026-09-09T12:00',
        days: 1,
      });
      expect(burner.days[0]).toMatchObject({
        hoursOn: 3,
        hoursUnknown: 1,
        starts: 0,
      });
    });

    it('leaves a run ended by an unknown out of the shortest run', () => {
      const burner = summariseBurner({
        transitions: [
          transition('2026-09-09T00:00', false),
          transition('2026-09-09T08:00', true),
          transition('2026-09-09T08:01', null),
        ],
        nowLocal: '2026-09-09T12:00',
        days: 1,
      });
      expect(burner.days[0]).toMatchObject({
        starts: 1,
        shortestRunMinutes: null,
      });
    });

    it('ignores history on the same line from before the device claimed it', () => {
      const burner = summariseBurner({
        transitions: [
          transition('2026-09-09T00:00', true, null),
          transition('2026-09-09T06:00', false),
        ],
        nowLocal: '2026-09-09T12:00',
        days: 1,
      });
      expect(burner.days[0]).toMatchObject({
        hoursOn: 0,
        hoursOff: 6,
        hoursUnknown: 6,
      });
    });
  });

  describe('a node that went offline mid-run', () => {
    const offlineScenario: Scenario = {
      transitions: [
        transition('2026-09-09T00:00', false),
        transition('2026-09-09T08:00', true),
      ],
      nowLocal: '2026-09-09T12:00',
      days: 1,
      sighting: { isOnline: false, lastHeardAt: atLocal('2026-09-09T09:00') },
    };

    it('caps the run at the node last-seen time and marks the day', () => {
      expect(summariseBurner(offlineScenario).days[0]).toMatchObject({
        hoursOn: 1,
        hoursUnknown: 3,
        starts: 1,
        shortestRunMinutes: null,
        hasRunCappedAtLastSeen: true,
      });
    });

    it('marks every day the capped run touches', () => {
      const days = summariseBurner({
        ...offlineScenario,
        transitions: [
          transition('2026-09-08T00:00', false),
          transition('2026-09-08T23:00', true),
        ],
        days: 2,
      }).days;
      expect(days.map((day) => day.hasRunCappedAtLastSeen)).toEqual([
        true,
        true,
      ]);
      expect(days.map((day) => day.hoursOn)).toEqual([1, 9]);
    });

    it('runs to now while the node is online', () => {
      expect(
        summariseBurner({ ...offlineScenario, sighting: ONLINE }).days[0],
      ).toMatchObject({ hoursOn: 4, hasRunCappedAtLastSeen: false });
    });

    it('ends the run at its own start when the node was never heard from', () => {
      expect(
        summariseBurner({
          ...offlineScenario,
          sighting: { isOnline: false, lastHeardAt: null },
        }).days[0],
      ).toMatchObject({
        hoursOn: 0,
        hoursUnknown: 4,
        hasRunCappedAtLastSeen: true,
      });
    });

    it('treats a node with no sighting at all as offline', () => {
      const [burner] = summariseEquipmentRuntime({
        devices: [BURNER],
        transitions: offlineScenario.transitions,
        sightingsByNode: new Map(),
        days: 1,
        now: atLocal('2026-09-09T12:00'),
      });
      expect(burner.days[0].hasRunCappedAtLastSeen).toBe(true);
    });
  });

  // Toronto, not Vancouver: British Columbia stays on daylight time from 2026, so it has no fall-back day.
  describe('a DST day', () => {
    const DST_TIMEZONE = 'America/Toronto';
    const atToronto = (iso: string): Date =>
      DateTime.fromISO(iso, { zone: DST_TIMEZONE }).toJSDate();

    function summariseTorontoDay(
      switchedOnLocal: string,
      nowLocal: string,
    ): DeviceRuntime['days'][number] {
      const [burner] = summariseEquipmentRuntime({
        devices: [{ ...BURNER, timezone: DST_TIMEZONE }],
        transitions: [
          {
            ...transition('2026-01-01T00:00', true),
            observedAt: atToronto(switchedOnLocal),
          },
        ],
        sightingsByNode: new Map([[NODE_SLUG, ONLINE]]),
        days: 2,
        now: atToronto(nowLocal),
      });
      return burner.days[0];
    }

    it('is 23 hours long when the clocks go forward', () => {
      expect(
        summariseTorontoDay('2026-03-07T00:00', '2026-03-09T00:00'),
      ).toMatchObject({ date: '2026-03-08', hoursOn: 23, hoursUnknown: 0 });
    });

    it('is 25 hours long when the clocks go back', () => {
      expect(
        summariseTorontoDay('2026-10-31T00:00', '2026-11-02T00:00'),
      ).toMatchObject({ date: '2026-11-01', hoursOn: 25, hoursUnknown: 0 });
    });
  });

  it('reports a device with no transitions as wholly unknown', () => {
    const burner = summariseBurner({
      transitions: [],
      nowLocal: '2026-09-09T12:00',
      days: 1,
    });
    expect(burner.days[0]).toMatchObject({
      hoursOn: 0,
      hoursOff: 0,
      hoursUnknown: 12,
      starts: 0,
      shortestRunMinutes: null,
    });
  });

  it('keeps each device to its own line', () => {
    const heater: RuntimeDevice = { ...BURNER, id: 'heater-device' };
    const heaterRow: RuntimeTransition = {
      ...transition('2026-09-09T00:00', true, heater.id),
      pin: 27,
    };
    const [burner, heaterRuntime] = summarise({
      devices: [BURNER, heater],
      transitions: [transition('2026-09-09T00:00', false), heaterRow],
      nowLocal: '2026-09-09T12:00',
      days: 1,
    });
    expect(burner.days[0].hoursOn).toBe(0);
    expect(heaterRuntime.days[0].hoursOn).toBe(12);
  });

  it('refuses an invalid timezone rather than guessing', () => {
    expect(() =>
      summarise({
        devices: [{ ...BURNER, timezone: 'Mars/Olympus' }],
        transitions: [],
        nowLocal: '2026-09-09T12:00',
        days: 1,
      }),
    ).toThrow(/Invalid timezone/);
  });
});
