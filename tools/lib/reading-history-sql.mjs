import { quote, quoteInstant } from './sql-literals.mjs';

// Marks every seeded row, so a rerun replaces only its own rows and never a real reading.
export const SEEDED_BOOT_ID = 'seeded-history';

const ROWS_PER_INSERT = 1000;

export function buildFindProbesSql(defaultTimezone) {
  return `select coalesce(json_agg(probe order by probe."nodeId", probe."sensorId"), '[]')
     from (
       select reading.node_id as "nodeUuid", node.slug as "nodeId", reading.sensor_id as "sensorId",
              coalesce(zone.rules_config->>'timezone', ${quote(defaultTimezone)}) as timezone,
              bool_or(reading.humidity is not null) as "reportsHumidity",
              bool_or(reading.co2 is not null) as "reportsCo2"
         from sensor_readings reading
         join nodes node on node.id = reading.node_id
         left join zones zone on zone.id = node.zone_id
        where reading.boot_id is distinct from ${quote(SEEDED_BOOT_ID)}
        group by reading.node_id, node.slug, reading.sensor_id, zone.rules_config->>'timezone'
     ) probe`;
}

export function buildFindFirstRealReadingsSql(probeStarts) {
  const values = probeStarts.map(
    ({ probe, historyStart }) =>
      `(${quote(probe.nodeUuid)}::uuid, ${quote(probe.sensorId)}, ${quoteInstant(historyStart)})`,
  );
  return `select coalesce(json_agg(json_build_object(
              'nodeUuid', probe_start.node_uuid, 'sensorId', probe_start.sensor_id,
              'at', first_real.created_at, 'temperature', first_real.temperature)), '[]')
     from (values ${values.join(', ')}) as probe_start(node_uuid, sensor_id, history_start)
     cross join lateral (
       select reading.created_at, reading.temperature
         from sensor_readings reading
        where reading.node_id = probe_start.node_uuid
          and reading.sensor_id = probe_start.sensor_id
          and reading.boot_id is distinct from ${quote(SEEDED_BOOT_ID)}
          and reading.created_at >= probe_start.history_start
        order by reading.created_at
        limit 1
     ) first_real`;
}

// A probe with no real reading in the window is dropped, so a long-dead sensor never looks alive.
export function attachFirstRealReading(probes, firstRealReadings) {
  return probes.flatMap((probe) => {
    const firstRealReading = firstRealReadings.find(
      (reading) =>
        reading.nodeUuid === probe.nodeUuid &&
        reading.sensorId === probe.sensorId,
    );
    if (!firstRealReading) return [];
    return [
      {
        ...probe,
        firstRealReading: {
          at: new Date(firstRealReading.at),
          temperature: firstRealReading.temperature,
        },
      },
    ];
  });
}

export function buildReplaceReadingsSql(probeReadings) {
  const statements = ['begin;'];
  for (const { probe } of probeReadings) {
    statements.push(
      `delete from sensor_readings where boot_id = ${quote(SEEDED_BOOT_ID)}` +
        ` and node_id = ${quote(probe.nodeUuid)} and sensor_id = ${quote(probe.sensorId)};`,
    );
  }
  const allRows = probeReadings.flatMap((readings) => readings.rows);
  for (let index = 0; index < allRows.length; index += ROWS_PER_INSERT) {
    statements.push(buildInsert(allRows.slice(index, index + ROWS_PER_INSERT)));
  }
  statements.push('commit;');
  return statements.join('\n');
}

function buildInsert(rows) {
  const values = rows.map(
    (row) =>
      `(${quote(row.nodeUuid)}, ${quote(row.sensorId)}, ${row.temperature}, ${row.humidity ?? 'null'}, ` +
      `${row.co2 ?? 'null'}, ${row.nodeSeq}, ${quote(SEEDED_BOOT_ID)}, ` +
      `${quoteInstant(row.createdAt)}, ${quoteInstant(row.createdAt)})`,
  );
  return (
    'insert into sensor_readings (node_id, sensor_id, temperature, humidity, co2, node_seq, boot_id, node_ts, created_at) values\n' +
    values.join(',\n') +
    ';'
  );
}
