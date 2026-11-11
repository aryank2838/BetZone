import { describe, expect, it } from 'vitest';
import { buildLedgerCsv } from '@/lib/ledgerCsv';

describe('wallet statement CSV', () => {
  it('exports only the requested columns with IST ISO dates and friendly labels', () => {
    const csv = buildLedgerCsv([{
      delta: 500,
      reason: 'selection_submit',
      metadata: {
        game: 'test',
        bet_type: 'jodi',
        round_date: '2026-11-09',
        actor_id: 'must-not-export',
      },
      created_at: '2026-11-09T12:00:00.000Z',
    }]);

    expect(csv.split('\r\n')[0]).toBe('"date (IST, ISO)","type","delta","game","bet type","round date"');
    expect(csv).toContain('"2026-11-09T17:30:00+05:30","Game entry","500","test","jodi","2026-11-09"');
    expect(csv).not.toContain('must-not-export');
  });

  it('keeps negative deltas numeric and escapes formula-like string fields', () => {
    const csv = buildLedgerCsv([{
      delta: -10,
      reason: '=2+2',
      metadata: { game: '=1,"x"', bet_type: '@SUM(1,2)', round_date: '+cmd' },
      created_at: '2026-11-09T12:00:00.000Z',
    }, {
      delta: 10,
      reason: 'selection_submit',
      metadata: { game: '=2+2', bet_type: '@SUM(1,2)', round_date: '\t=1' },
      created_at: '2026-11-09T12:00:00.000Z',
    }]);
    expect(csv).toContain('"Other transaction","-10"');
    expect(csv).toContain('"Other transaction"');
    expect(csv).toContain('"\u0027=1,""x"""');
    expect(csv).toContain('"\u0027@SUM(1,2)"');
    expect(csv).toContain('"\u0027+cmd"');
    expect(csv).toContain('"\u0027=2+2","\'@SUM(1,2)","\'\t=1"');
  });
});
