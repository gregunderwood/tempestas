import { describe, expect, it } from 'vitest';
import type { RulesCycle, SystemStatus } from '@tempestas/domain';
import { chooseCurrentCycle, pickNewerCycle } from './live-rules-cycle';

const cycleAt = (at: string): RulesCycle => ({
  at,
  evaluations: [],
  failingZones: [],
});

describe('pickNewerCycle', () => {
  const older = cycleAt('2026-11-20T21:13:50.000Z');
  const newer = cycleAt('2026-11-20T21:14:00.000Z');

  it('takes whichever cycle is newer, from either source', () => {
    expect(pickNewerCycle(older, newer)).toBe(newer);
    expect(pickNewerCycle(newer, older)).toBe(newer);
  });

  it('falls back to whichever one exists', () => {
    expect(pickNewerCycle(null, older)).toBe(older);
    expect(pickNewerCycle(older, null)).toBe(older);
    expect(pickNewerCycle(null, null)).toBeNull();
  });
});

describe('chooseCurrentCycle', () => {
  const cycle = cycleAt('2026-11-20T21:14:00.000Z');
  const statusLeading = (isLeading: boolean) => ({ isLeading }) as SystemStatus;

  it('shows no cycle on a server that has stopped leading', () => {
    expect(chooseCurrentCycle(statusLeading(false), cycle, cycle)).toBeNull();
  });

  it('shows the cycle while leading, or before any status arrives', () => {
    expect(chooseCurrentCycle(statusLeading(true), cycle, null)).toBe(cycle);
    expect(chooseCurrentCycle(null, null, cycle)).toBe(cycle);
  });
});
