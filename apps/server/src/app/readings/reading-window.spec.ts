import { resolveReadingWindow } from './reading-window';

const VANCOUVER = 'America/Vancouver';
// 12:04 PST.
const NOW = new Date('2026-01-10T20:04:00Z');

describe('resolveReadingWindow', () => {
  it('defaults to a rolling 24 hours, not a calendar day', () => {
    const { from, to } = resolveReadingWindow({}, NOW, VANCOUVER);
    expect(from.toISOString()).toBe('2026-01-09T20:04:00.000Z');
    expect(to).toBe(NOW);
  });

  it('never returns a `to` in the future, even when asked', () => {
    const { to } = resolveReadingWindow(
      { to: '2026-06-01T00:00:00Z' },
      NOW,
      VANCOUVER,
    );
    expect(to).toBe(NOW);
  });

  it('honours a `to` in the past', () => {
    const { to } = resolveReadingWindow(
      { to: '2026-01-10T06:00:00Z' },
      NOW,
      VANCOUVER,
    );
    expect(to.toISOString()).toBe('2026-01-10T06:00:00.000Z');
  });

  it('aligns `days=1` to the start of the local day', () => {
    const { from, to } = resolveReadingWindow({ days: 1 }, NOW, VANCOUVER);
    // Midnight PST on the 10th, not 24 hours ago.
    expect(from.toISOString()).toBe('2026-01-10T08:00:00.000Z');
    expect(to).toBe(NOW);
  });

  it('counts `days=7` as seven calendar days including today', () => {
    const { from } = resolveReadingWindow({ days: 7 }, NOW, VANCOUVER);
    expect(from.toISOString()).toBe('2026-01-04T08:00:00.000Z');
  });

  // March 8 2026 is a 23-hour day in Vancouver.
  it('lands on local midnight across a spring-forward boundary', () => {
    const afterTransition = new Date('2026-03-09T20:00:00Z'); // 13:00 PDT
    const { from } = resolveReadingWindow(
      { days: 2 },
      afterTransition,
      VANCOUVER,
    );
    // Midnight on the 8th is still PST (-8); the change happens at 02:00.
    expect(from.toISOString()).toBe('2026-03-08T08:00:00.000Z');
  });

  it('uses an explicit `from` verbatim, ignoring `days`', () => {
    const { from } = resolveReadingWindow(
      { from: '2026-01-01T00:00:00Z', days: 2 },
      NOW,
      VANCOUVER,
    );
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('keeps the offset of an explicit instant', () => {
    const { from } = resolveReadingWindow(
      { from: '2026-01-10T00:00:00-08:00' },
      NOW,
      VANCOUVER,
    );
    expect(from.toISOString()).toBe('2026-01-10T08:00:00.000Z');
  });

  it('refuses a reversed range rather than swapping it', () => {
    expect(() =>
      resolveReadingWindow(
        { from: '2026-01-10T18:00:00Z', to: '2026-01-10T06:00:00Z' },
        NOW,
        VANCOUVER,
      ),
    ).toThrow(RangeError);
  });

  it.each(['not-a-date', '2026-13-45T00:00:00Z'])(
    'refuses %s as a timestamp',
    (value) => {
      expect(() =>
        resolveReadingWindow({ from: value }, NOW, VANCOUVER),
      ).toThrow(RangeError);
    },
  );

  // `@IsISO8601()` on the DTO rejects `?from=`; `@IsOptional()` skips only null and undefined.
  it('treats an empty string as absent', () => {
    const { from } = resolveReadingWindow({ from: '' }, NOW, VANCOUVER);
    expect(from.toISOString()).toBe('2026-01-09T20:04:00.000Z');
  });

  it('refuses an invalid timezone rather than falling back to the host', () => {
    expect(() =>
      resolveReadingWindow({ days: 2 }, NOW, 'Mars/Olympus_Mons'),
    ).toThrow(RangeError);
  });
});
