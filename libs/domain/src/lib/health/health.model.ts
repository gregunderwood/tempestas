import type { DeviceRole } from '../devices/device.model';

/**
 * The endpoint you curl at 2 a.m. when the greenhouse is cold.
 *
 * It answers the three questions that matter in that moment, in order: is the
 * database up, are readings still arriving, and is the rules engine still
 * evaluating? A system that is "up" but has not evaluated a rule in an hour is
 * not up.
 */
export interface HealthReport {
  status: 'ok' | 'degraded';
  db: boolean;
  uptimeSeconds: number;
  nodes: { total: number; online: number; pending: number };
  readings: { latestAt: string | null; ageSeconds: number | null };
  rules: {
    lastEvaluationAt: string | null;
    ageSeconds: number | null;
    staleRoles: DeviceRole[];
  };
  /** Why the status is degraded. Empty when it is ok. */
  problems: string[];
}
