import { quote, quoteInstant } from './sql-literals.mjs';

const ROWS_PER_INSERT = 500;

export function buildReplaceHistorySql({ histories, now }) {
  const statements = ['begin;'];
  for (const { line, historyStart } of histories) {
    statements.push(
      `delete from pin_transitions where node_id = ${quote(line.nodeId)} and pin = ${line.pin}` +
        ` and observed_at between ${quoteInstant(historyStart)} and ${quoteInstant(now)};`,
      `update devices set created_at = least(created_at, ${quoteInstant(historyStart)})` +
        ` where id = ${quote(line.deviceId)};`,
    );
  }
  const allRows = histories.flatMap((history) => history.rows);
  for (let index = 0; index < allRows.length; index += ROWS_PER_INSERT) {
    statements.push(buildInsert(allRows.slice(index, index + ROWS_PER_INSERT)));
  }
  statements.push('commit;');
  return statements.join('\n');
}

function buildInsert(rows) {
  const values = rows.map(
    (row) =>
      `(${quote(row.nodeId)}, ${row.pin}, ${row.level ?? 'null'}, ${row.known}, ${row.energised ?? 'null'}, ` +
      `${quote(row.deviceId)}, ${row.role === null ? 'null' : quote(row.role)}, ${quote(row.reason)}, ` +
      `${quoteInstant(row.observedAt)})`,
  );
  return (
    'insert into pin_transitions (node_id, pin, level, known, energised, device_id, role, reason, observed_at) values\n' +
    values.join(',\n') +
    ';'
  );
}
