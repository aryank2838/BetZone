import { describe, expect, it } from 'vitest';
import { buildCsv, quoteCsvCell } from '@/lib/csv';

describe('CSV serialization', () => {
  it('keeps numeric cells numeric, including negative values', () => {
    expect(quoteCsvCell(-10)).toBe('"-10"');
    expect(buildCsv([[-10, 10]])).toBe('"-10","10"');
  });

  it('guards formula-like string cells after leading whitespace', () => {
    expect(quoteCsvCell('  =2+2')).toBe('"\'  =2+2"');
    expect(quoteCsvCell('@SUM(1,2)')).toBe('"\'@SUM(1,2)"');
    expect(quoteCsvCell('\t=1')).toBe('"\'\t=1"');
    expect(quoteCsvCell('\r=1')).toBe('"\'\r=1"');
    expect(quoteCsvCell(' \ttext')).toBe('"\' \ttext"');
    expect(quoteCsvCell('  -10')).toBe('"\'  -10"');
  });

  it('doubles quotes in string cells', () => {
    expect(quoteCsvCell('a,"b"')).toBe('"a,""b"""');
  });
});
