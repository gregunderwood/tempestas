import type { Repository } from 'typeorm';
import { FixedClock } from '../common/clock';
import type { ZoneEntity } from '../zones/models';
import {
  readSystemOffsetFromDate,
  TimezoneCheckService,
} from './timezone-check.service';

const WINTER = new Date('2027-01-15T20:00:00Z');

function makeCheck(
  systemOffset: string | null,
  zoneTimezones = ['Europe/London'],
) {
  const zones = {
    find: vi.fn(async () =>
      zoneTimezones.map((timezone) => ({ rulesConfig: { timezone } })),
    ),
  } as unknown as Repository<ZoneEntity>;
  return new TimezoneCheckService(
    zones,
    new FixedClock(WINTER),
    () => systemOffset,
  );
}

describe('TimezoneCheckService', () => {
  it('remembers a disagreement until the next check', async () => {
    const check = makeCheck('+01:00');
    await check.check();
    expect(check.findDisagreements()).toEqual([
      {
        timezone: 'Europe/London',
        serverOffset: '+00:00',
        systemOffset: '+01:00',
      },
    ]);
  });

  it('has nothing to report when they agree', async () => {
    const check = makeCheck('+00:00');
    await check.check();
    expect(check.findDisagreements()).toEqual([]);
  });

  it('keeps the last answer when the zones cannot be read', async () => {
    const check = makeCheck('+01:00');
    await check.check();
    const zonesUnreadable = check as unknown as {
      zones: { find: () => Promise<never> };
    };
    zonesUnreadable.zones.find = async () => {
      throw new Error('db gone');
    };
    await check.check();
    expect(check.findDisagreements()).toHaveLength(1);
  });
});

describe('readSystemOffsetFromDate', () => {
  it('asks the OS for a zone with no DST', () => {
    expect(readSystemOffsetFromDate('Etc/GMT+5')).toBe('-05:00');
  });
});
