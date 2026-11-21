import {
  findTimezoneDisagreements,
  toColonOffset,
  type ReadSystemOffset,
} from './timezone-agreement';

const WINTER = new Date('2027-01-15T20:00:00Z');
const SUMMER = new Date('2027-07-15T20:00:00Z');

const systemSays =
  (offsets: Record<string, string | null>): ReadSystemOffset =>
  (timezone) =>
    offsets[timezone] ?? null;

describe('findTimezoneDisagreements', () => {
  it('is quiet when Node and the OS give the same offset', () => {
    expect(
      findTimezoneDisagreements(
        ['Europe/London'],
        WINTER,
        systemSays({ 'Europe/London': '+00:00' }),
      ),
    ).toEqual([]);
  });

  it('names a zone where they differ', () => {
    expect(
      findTimezoneDisagreements(
        ['Europe/London'],
        SUMMER,
        systemSays({ 'Europe/London': '+00:00' }),
      ),
    ).toEqual([
      {
        timezone: 'Europe/London',
        serverOffset: '+01:00',
        systemOffset: '+00:00',
      },
    ]);
  });

  it('checks each zone once, however many zones share it', () => {
    const readSystemOffset = vi.fn(systemSays({ 'Europe/London': '+00:00' }));
    findTimezoneDisagreements(
      ['Europe/London', 'Europe/London'],
      WINTER,
      readSystemOffset,
    );
    expect(readSystemOffset).toHaveBeenCalledTimes(1);
  });

  it('cannot compare when the OS gives no answer, so it says nothing', () => {
    expect(
      findTimezoneDisagreements(['Europe/London'], SUMMER, systemSays({})),
    ).toEqual([]);
  });

  it('leaves an invalid zone to the rules engine, which already reports it', () => {
    expect(
      findTimezoneDisagreements(
        ['Mars/Olympus_Mons'],
        WINTER,
        systemSays({ 'Mars/Olympus_Mons': '+00:00' }),
      ),
    ).toEqual([]);
  });
});

describe('toColonOffset', () => {
  it.each([
    ['-0700', '-07:00'],
    ['+0530', '+05:30'],
    ['+0000\n', '+00:00'],
  ])('reads %j as %s', (compactOffset, expected) => {
    expect(toColonOffset(compactOffset)).toBe(expected);
  });

  it('refuses anything else', () => {
    expect(toColonOffset('MST')).toBeNull();
  });
});
