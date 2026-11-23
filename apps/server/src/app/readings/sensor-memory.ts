import { MILLISECONDS_PER_SECOND, SECONDS_PER_DAY } from '../common/time-units';

// A day, so a probe removed on purpose stops being shown while one that died overnight still is.
export const SENSOR_MEMORY_SECONDS = SECONDS_PER_DAY;

export function rememberSensorsSince(now: Date): Date {
  return new Date(
    now.getTime() - SENSOR_MEMORY_SECONDS * MILLISECONDS_PER_SECOND,
  );
}
