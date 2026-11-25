// The probes that have reported a real reading, each with its first one in the window, for both seeders.
import { readJson } from './development-database-psql.mjs';
import { DEFAULT_TIMEZONE, findHistoryStart } from './history-window.mjs';
import {
  attachFirstRealReading,
  buildFindFirstRealReadingsSql,
  buildFindProbesSql,
} from './reading-history-sql.mjs';

export function readProbesWithRealReadings(databaseName, now) {
  const probes = readJson(databaseName, buildFindProbesSql(DEFAULT_TIMEZONE));
  if (probes.length === 0) return [];
  const probeStarts = probes.map((probe) => ({
    probe,
    historyStart: findHistoryStart(now, probe.timezone),
  }));
  const firstRealReadings = readJson(
    databaseName,
    buildFindFirstRealReadingsSql(probeStarts),
  );
  return attachFirstRealReading(probes, firstRealReadings);
}
