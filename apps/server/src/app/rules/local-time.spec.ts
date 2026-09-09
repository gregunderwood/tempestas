import { localTimeLabel, minutesSinceMidnight } from './local-time';

const VANCOUVER = 'America/Vancouver';

/**
 * These are the tests the Python system fails, and the reason for the port.
 *
 * It resolved local time through the host's CURRENT UTC offset, so a reading
 * taken in July was interpreted with January's offset. Every rule evaluation
 * near a window edge and every historical query was an hour out for half the
 * year.
 */
describe('minutesSinceMidnight', () => {
  it('resolves an instant through the given zone, not the host', () => {
    // 20:04Z in January is 12:04 PST (-8).
    expect(
      minutesSinceMidnight(new Date('2026-01-10T20:04:00Z'), VANCOUVER),
    ).toBe(12 * 60 + 4);
  });

  // THE case. Same UTC wall time, six months apart, different local time -
  // because each instant resolves with ITS OWN offset.
  it('gives a July and a January instant different local times', () => {
    const january = minutesSinceMidnight(
      new Date('2026-01-15T20:00:00Z'),
      VANCOUVER,
    );
    const july = minutesSinceMidnight(
      new Date('2026-07-15T20:00:00Z'),
      VANCOUVER,
    );

    expect(january).toBe(12 * 60); // 12:00 PST (-8)
    expect(july).toBe(13 * 60); //   13:00 PDT (-7)
    expect(july - january).toBe(60);
  });

  // Spring forward 2026: 02:00 local does not exist on March 8.
  it('skips the missing hour at the spring-forward boundary', () => {
    expect(
      minutesSinceMidnight(new Date('2026-03-08T09:59:00Z'), VANCOUVER),
    ).toBe(1 * 60 + 59);
    expect(
      minutesSinceMidnight(new Date('2026-03-08T10:00:00Z'), VANCOUVER),
    ).toBe(3 * 60);
  });

  // Fall back 2026: 01:30 local happens twice on November 1, an hour apart.
  // Both are 01:30, both get 90, and the rules engine is RIGHT to treat them
  // identically - "is it night?" has one answer at 01:30 however often 01:30
  // happens. The point is that neither is silently shifted by an hour.
  it('gives both fall-back 01:30 instants the same local minute', () => {
    const beforeTransition = new Date('2026-11-01T08:30:00Z'); // 01:30 PDT
    const afterTransition = new Date('2026-11-01T09:30:00Z'); //  01:30 PST

    expect(beforeTransition.getTime()).not.toBe(afterTransition.getTime());
    expect(minutesSinceMidnight(beforeTransition, VANCOUVER)).toBe(90);
    expect(minutesSinceMidnight(afterTransition, VANCOUVER)).toBe(90);
  });

  it('is 0 at local midnight, on both sides of a DST change', () => {
    expect(
      minutesSinceMidnight(new Date('2026-01-10T08:00:00Z'), VANCOUVER),
    ).toBe(0);
    expect(
      minutesSinceMidnight(new Date('2026-07-10T07:00:00Z'), VANCOUVER),
    ).toBe(0);
  });

  it('resolves a different zone differently, proving nothing is hardcoded', () => {
    const instant = new Date('2026-01-10T20:04:00Z');
    expect(minutesSinceMidnight(instant, 'UTC')).toBe(20 * 60 + 4);
    expect(minutesSinceMidnight(instant, VANCOUVER)).toBe(12 * 60 + 4);
  });

  // A silent fallback to the host zone is precisely the bug this module exists
  // to prevent, so a bad IANA name has to be loud.
  it('throws on an invalid zone rather than falling back to the host', () => {
    expect(() => minutesSinceMidnight(new Date(), 'Mars/Olympus_Mons')).toThrow(
      /Invalid timezone/,
    );
  });
});

describe('localTimeLabel', () => {
  it('formats zero-padded local wall clock', () => {
    expect(localTimeLabel(new Date('2026-01-10T20:04:00Z'), VANCOUVER)).toBe(
      '12:04',
    );
    expect(localTimeLabel(new Date('2026-01-10T16:00:00Z'), VANCOUVER)).toBe(
      '08:00',
    );
  });

  it('throws on an invalid zone', () => {
    expect(() => localTimeLabel(new Date(), 'Nowhere/Nothing')).toThrow(
      /Invalid timezone/,
    );
  });
});
