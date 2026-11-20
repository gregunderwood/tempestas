import { describe, expect, it } from 'vitest';
import type { DecisionOutcome } from '@tempestas/domain';
import { pumphouseEvaluation } from './zone-fixtures';
import {
  chooseDecisionTone,
  describeDispatch,
  describeSensorPolicy,
  formatDuration,
  formatHourMinute,
  parseHourMinute,
} from './zone-words';

describe('chooseDecisionTone', () => {
  const heaterDecision = pumphouseEvaluation().decisions[0];
  const toneOf = (overrides: Partial<DecisionOutcome>): string =>
    chooseDecisionTone({ ...heaterDecision, ...overrides });

  it('raises a stale or sensorless decision as a warning, not as on/off', () => {
    expect(toneOf({ desired: 'on', reason: 'stale-failsafe' })).toBe('warn');
    expect(toneOf({ desired: 'noop', reason: 'no-sensor' })).toBe('warn');
    expect(toneOf({ desired: 'noop', reason: 'dead-band' })).toBe('hold');
    expect(toneOf({ desired: 'on', reason: 'temp-below-setpoint' })).toBe('on');
  });
});

describe('describeSensorPolicy', () => {
  it('names every sensor source in words', () => {
    expect(describeSensorPolicy({ source: 'mean' })).toBe(
      'Controls on the average of every probe',
    );
    expect(describeSensorPolicy({ source: 'node:patji' })).toBe(
      'Controls on the probes on patji',
    );
    expect(
      describeSensorPolicy({ source: 'sensor:patji/pipes', maxAgeMs: 90_000 }),
    ).toBe('Controls on patji/pipes only · stale after 1:30');
  });

  it('shows a source it does not know as stored', () => {
    expect(
      describeSensorPolicy({ source: 'median' as unknown as 'mean' }),
    ).toBe('Controls on median');
  });
});

describe('describeDispatch', () => {
  it('says why a dispatch failed', () => {
    expect(
      describeDispatch({
        deviceId: 'd-heater',
        deviceName: 'Heater',
        outcome: 'failed',
        detail: 'NODE_OFFLINE',
      }),
    ).toBe('FAILED: NODE_OFFLINE');
  });
});

describe('formatDuration', () => {
  it('formats durations for a countdown', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(120)).toBe('2 min');
    expect(formatDuration(192)).toBe('3:12');
    expect(formatDuration(3_900)).toBe('1 h 5 min');
  });
});

describe('hour and minute', () => {
  it('reads HH:MM as minutes since midnight and writes it back', () => {
    expect(parseHourMinute('06:30')).toBe(390);
    expect(formatHourMinute(390)).toBe('06:30');
  });

  it('refuses anything that is not a time of day', () => {
    expect(parseHourMinute('7:00am')).toBeNull();
    expect(parseHourMinute('24:00')).toBeNull();
    expect(parseHourMinute(700)).toBeNull();
  });
});
