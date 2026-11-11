import { describe, expect, it } from 'vitest';
import { isUuid } from '@/lib/uuid';
import { roundNet, settledStake } from '@/lib/betRounds';
import { betLimitsFromRules, FALLBACK_BET_LIMITS, QUICK_STAKES } from '@/lib/betLimits';
import { ledgerMetadataSummary, picksSummary } from '@/components/admin/userDetailFormat';

describe('support request ID validation (B8)', () => {
  it('accepts only full UUIDs', () => {
    expect(isUuid('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(isUuid(' 0F8FAD5B-D9CB-469F-A165-70867728950E ')).toBe(true);
    expect(isUuid('0f8fad5b')).toBe(false);
    expect(isUuid('UTR123456789')).toBe(false);
    expect(isUuid("0f8fad5b-d9cb-469f-a165-70867728950e' OR 1=1")).toBe(false);
  });
});

describe('my bets round totals (B8)', () => {
  it('does not count pending stakes as losses', () => {
    const round = { staked: 300, won: 90, pending_stake: 200 };
    expect(settledStake(round)).toBe(100);
    expect(roundNet(round)).toBe(-10);
    expect(roundNet({ staked: 100, won: 0, pending_stake: 100 })).toBe(0);
  });
});

describe('bet limits from get_public_rules (B8)', () => {
  it('uses server values and keeps quick stakes local', () => {
    const limits = betLimitsFromRules({
      minimum_withdrawal: 100, maximum_withdrawal: 100000, approved_deposit_minimum: 100,
      maximum_add_funds: 100000, turnover_multiplier: 1, maximum_bet: 2500, maximum_submit: 9000,
    });
    expect(limits).toEqual({ maxPerBet: 2500, maxPerSubmit: 9000, quickStakes: QUICK_STAKES });
    expect(betLimitsFromRules(null)).toBe(FALLBACK_BET_LIMITS);
  });
});

describe('admin user detail formatting (C4)', () => {
  it('omits UPI IDs and other internal ledger metadata', () => {
    expect(ledgerMetadataSummary({ upi_id: 'secret@okaxis', from_wallet: 10 })).toBe('');
    expect(ledgerMetadataSummary({ game: 'test', bet_type: 'jodi', round_date: '2026-11-11', new_numbers: 2, upi_id: 'x@y' }))
      .toBe('Game: test · Bet type: jodi · Round: 2026-11-11');
    expect(ledgerMetadataSummary(null)).toBe('');
  });

  it('summarises picks', () => {
    expect(picksSummary([{ number: '7', points: 10 }, { number: '12', points: 50 }])).toBe('7×10, 12×50');
    expect(picksSummary('not an array')).toBe('');
  });
});
