import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { quote, quoteInstant } from './sql-literals.mjs';

describe('quote', () => {
  it('doubles a single quote so a slug cannot end the string', () => {
    assert.equal(quote("o'brien"), "'o''brien'");
  });
});

describe('quoteInstant', () => {
  it('writes an instant as a UTC timestamptz literal', () => {
    assert.equal(
      quoteInstant(new Date('2026-10-24T07:00:00Z')),
      "'2026-10-24T07:00:00.000Z'::timestamptz",
    );
  });
});
