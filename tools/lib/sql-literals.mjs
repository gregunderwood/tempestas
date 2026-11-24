export function quote(text) {
  return `'${String(text).replaceAll("'", "''")}'`;
}

export function quoteInstant(instant) {
  return `${quote(instant.toISOString())}::timestamptz`;
}
