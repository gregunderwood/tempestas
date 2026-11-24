import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_DAYS } from './history-window.mjs';
import {
  findNightColdness,
  FREEZING_NIGHTS_DAYS_AGO,
} from './simulated-weather.mjs';

const ALL_NIGHTS = Array.from(
  { length: HISTORY_DAYS + 2 },
  (_, daysAgo) => daysAgo,
);

describe('findNightColdness', () => {
  it('is coldest on the freezing nights only', () => {
    const coldestNights = ALL_NIGHTS.filter(
      (daysAgo) => findNightColdness(daysAgo) === 1,
    );
    assert.deepEqual(coldestNights, FREEZING_NIGHTS_DAYS_AGO);
  });

  it('keeps every other night between mild and cold', () => {
    for (const daysAgo of ALL_NIGHTS) {
      const coldness = findNightColdness(daysAgo);
      assert.ok(
        coldness >= 0 && coldness <= 1,
        `night ${daysAgo}: ${coldness}`,
      );
    }
  });

  it('is the same night after night', () => {
    assert.deepEqual(
      ALL_NIGHTS.map(findNightColdness),
      ALL_NIGHTS.map(findNightColdness),
    );
  });
});
