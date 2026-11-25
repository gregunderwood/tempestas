import type { DeviceRole } from '../devices/device.model';

/** A server that is up but has stopped evaluating rules reports `degraded`. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  db: boolean;
  /** The deployed release this server runs; null when run from a checkout. */
  releaseId: string | null;
  /** From tools/describe-product-version.sh at deploy; null when run from a checkout. */
  productVersion: string | null;
  uptimeSeconds: number;
  nodes: { total: number; online: number; pending: number };
  readings: { latestAt: string | null; ageSeconds: number | null };
  rules: {
    lastEvaluationAt: string | null;
    ageSeconds: number | null;
    staleRoles: DeviceRole[];
  };
  /** Empty when the status is ok. */
  problems: string[];
}
