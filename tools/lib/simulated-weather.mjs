// Pure: how cold each night of the seeded history is, so heater runs and readings agree.
import { seededRandom } from './seeded-random.mjs';

export const FREEZING_NIGHTS_DAYS_AGO = [4, 17];

const COLDEST_ORDINARY_NIGHT = 0.8;

/**
 * 0 for the mildest night, 1 for a night near freezing. A night is named by how many days ago its
 * evening was, in the zone's timezone, so every zone shares the same weather.
 */
export function findNightColdness(daysAgo) {
  if (FREEZING_NIGHTS_DAYS_AGO.includes(daysAgo)) return 1;
  return COLDEST_ORDINARY_NIGHT * seededRandom(`night:${daysAgo}`)();
}
