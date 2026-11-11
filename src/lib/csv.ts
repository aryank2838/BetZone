export function quoteCsvCell(value: string | number) {
  const text = String(value);
  const shouldGuard = typeof value === 'string'
    && (/^[\s]*[=+\-@]/.test(text) || /^[\s]*[\t\r]/.test(text));
  const safeValue = shouldGuard ? `'${text}` : text;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

export function buildCsv(rows: Array<Array<string | number>>) {
  return rows.map((row) => row.map(quoteCsvCell).join(',')).join('\r\n');
}
