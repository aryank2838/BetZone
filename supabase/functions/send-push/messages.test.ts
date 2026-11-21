import { describe, expect, it } from 'vitest';
import { buildMessage, groupOutbox, normalizeLanguage, ttlSeconds, type OutboxRow } from './messages.ts';

describe('push messages', () => {
  it('writes the amount with Indian digit grouping and opens the money screen', () => {
    expect(buildMessage('deposit_approved', 150000, null, 'en')).toEqual({
      title: 'Money added',
      body: '₹1,50,000 is now in your BetZone balance.',
      url: '/?open=money',
      tag: 'deposit_approved',
    });
  });

  it('includes the rejection reason when there is one', () => {
    expect(buildMessage('withdrawal_rejected', 500, '  Wrong UPI ID  ', 'hi').body)
      .toBe('₹500 आपके बैलेंस में वापस आ गए हैं। कारण: Wrong UPI ID');
    expect(buildMessage('deposit_rejected', 500, null, 'mr').body)
      .toBe('₹500 जोडण्याची तुमची विनंती नामंजूर झाली. कारण पाहण्यासाठी BetZone उघडा.');
  });

  it('opens My bets for winnings', () => {
    expect(buildMessage('winnings', 900, null, 'en').url).toBe('/?open=bets');
  });

  it('reminds about a match, opens Sports, and keeps one notification per match', () => {
    const first = buildMessage('match_starting', 1200, 'Arsenal vs Chelsea', 'en');
    expect(first).toEqual({
      title: 'Your match starts soon',
      body: 'Arsenal vs Chelsea starts soon. You have ₹1,200 on it.',
      url: '/?open=sports',
      tag: 'match_starting:Arsenal vs Chelsea',
    });
    expect(buildMessage('match_starting', 200, 'India vs Australia', 'hi').body)
      .toBe('India vs Australia जल्द शुरू होगा। इस पर आपके ₹200 लगे हैं।');
    expect(buildMessage('match_starting', 200, 'India vs Australia', 'mr').tag)
      .not.toBe(first.tag);
  });

  it('tells the inviter about a referral bonus and opens Money', () => {
    expect(buildMessage('referral_bonus', 150, 'Ravi', 'en')).toEqual({
      title: 'Referral bonus 🎉',
      body: 'Ravi added money. ₹150 bonus is in your play balance.',
      url: '/?open=money',
      tag: 'referral_bonus',
    });
    expect(buildMessage('referral_bonus', 150, null, 'mr').body)
      .toBe('तुम्ही बोलावलेल्या मित्राने पैसे जोडले. ₹150 बोनस तुमच्या प्ले बॅलन्समध्ये जोडला आहे.');
  });

  it('alerts admins to a new request with the player name and opens the Requests tab', () => {
    const deposit = buildMessage('admin_deposit', 2500, 'Ravi', 'en');
    expect(deposit).toEqual({
      title: 'New add-money request',
      body: 'Ravi wants to add ₹2,500. Tap to review.',
      url: '/?open=admin-requests',
      tag: 'admin_deposit:Ravi:2500',
    });
    expect(buildMessage('admin_withdrawal', 800, null, 'en').body).toBe('₹800 to withdraw. Tap to review.');
    // Two requests in a row stay as two notifications.
    expect(buildMessage('admin_deposit', 500, 'Ravi', 'en').tag).not.toBe(deposit.tag);
  });

  it('reminds admins how many requests are waiting, as a count rather than rupees', () => {
    expect(buildMessage('admin_waiting', 1200, '45', 'en').body).toBe('1200 waiting · oldest for 45 min. Tap to review.');
    expect(buildMessage('admin_waiting', 3, '45', 'hi').body)
      .toBe('3 अनुरोध इंतज़ार में · सबसे पुराना 45 मिनट से। देखने के लिए टैप करें।');
    expect(buildMessage('admin_waiting', 3, '12', 'mr').tag).toBe('admin_waiting');
  });

  it('expires reminders sooner than money and request alerts', () => {
    expect(ttlSeconds('admin_waiting')).toBe(30 * 60);
    expect(ttlSeconds('match_starting')).toBe(30 * 60);
    expect(ttlSeconds('admin_deposit')).toBe(6 * 60 * 60);
    expect(ttlSeconds('deposit_approved')).toBe(24 * 60 * 60);
  });

  it('falls back to English for unknown languages', () => {
    expect(normalizeLanguage('fr')).toBe('en');
    expect(normalizeLanguage(null)).toBe('en');
    expect(normalizeLanguage('mr')).toBe('mr');
  });

  it('merges a player\'s winnings into one notification but keeps money events separate', () => {
    const rows: OutboxRow[] = [
      { id: 1, user_id: 'a', kind: 'winnings', amount: 90, reason: null },
      { id: 2, user_id: 'a', kind: 'winnings', amount: 900, reason: null },
      { id: 3, user_id: 'b', kind: 'winnings', amount: 9, reason: null },
      { id: 4, user_id: 'a', kind: 'deposit_approved', amount: 500, reason: null },
      { id: 5, user_id: 'a', kind: 'deposit_approved', amount: 200, reason: null },
    ];
    const grouped = groupOutbox(rows);
    expect(grouped).toHaveLength(4);
    expect(grouped).toContainEqual({ user_id: 'a', kind: 'winnings', amount: 990, reason: null });
    expect(grouped).toContainEqual({ user_id: 'b', kind: 'winnings', amount: 9, reason: null });
    expect(grouped.filter((event) => event.kind === 'deposit_approved')).toHaveLength(2);
  });
});
