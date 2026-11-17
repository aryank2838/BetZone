// Notification text in the player's language. Kept short: phones cut
// titles at about 40 characters and bodies at about 2 lines.

export type PushKind =
  | 'deposit_approved'
  | 'deposit_rejected'
  | 'withdrawal_approved'
  | 'withdrawal_rejected'
  | 'winnings';

export type PushLanguage = 'en' | 'hi' | 'mr';

export interface OutboxRow {
  id: number;
  user_id: string;
  kind: PushKind;
  amount: number;
  reason: string | null;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Path the app opens when the notification is tapped. */
  url: string;
  /** Same tag replaces an older notification instead of stacking. */
  tag: string;
}

type Template = { title: string; body: string; bodyWithReason?: string };

const TEXT: Record<PushLanguage, Record<PushKind, Template>> = {
  en: {
    deposit_approved: { title: 'Money added', body: '₹{amount} is now in your BetZone balance.' },
    deposit_rejected: {
      title: 'Add-money request rejected',
      body: 'Your request to add ₹{amount} was rejected. Open BetZone to see why.',
      bodyWithReason: 'Your request to add ₹{amount} was rejected. Reason: {reason}',
    },
    withdrawal_approved: { title: 'Withdrawal sent', body: '₹{amount} has been sent to your UPI ID.' },
    withdrawal_rejected: {
      title: 'Withdrawal rejected',
      body: '₹{amount} is back in your balance. Open BetZone to see why.',
      bodyWithReason: '₹{amount} is back in your balance. Reason: {reason}',
    },
    winnings: { title: 'You won! 🎉', body: '₹{amount} in winnings has been added to your balance.' },
  },
  hi: {
    deposit_approved: { title: 'पैसे जुड़ गए', body: '₹{amount} आपके BetZone बैलेंस में जुड़ गए हैं।' },
    deposit_rejected: {
      title: 'पैसे जोड़ने का अनुरोध नामंज़ूर',
      body: '₹{amount} जोड़ने का आपका अनुरोध नामंज़ूर हो गया। कारण देखने के लिए BetZone खोलें।',
      bodyWithReason: '₹{amount} जोड़ने का आपका अनुरोध नामंज़ूर हो गया। कारण: {reason}',
    },
    withdrawal_approved: { title: 'पैसे भेज दिए गए', body: '₹{amount} आपकी UPI ID पर भेज दिए गए हैं।' },
    withdrawal_rejected: {
      title: 'निकासी नामंज़ूर',
      body: '₹{amount} आपके बैलेंस में वापस आ गए हैं। कारण देखने के लिए BetZone खोलें।',
      bodyWithReason: '₹{amount} आपके बैलेंस में वापस आ गए हैं। कारण: {reason}',
    },
    winnings: { title: 'आप जीत गए! 🎉', body: 'जीत के ₹{amount} आपके बैलेंस में जुड़ गए हैं।' },
  },
  mr: {
    deposit_approved: { title: 'पैसे जोडले गेले', body: '₹{amount} तुमच्या BetZone बॅलन्समध्ये जोडले गेले आहेत.' },
    deposit_rejected: {
      title: 'पैसे जोडण्याची विनंती नामंजूर',
      body: '₹{amount} जोडण्याची तुमची विनंती नामंजूर झाली. कारण पाहण्यासाठी BetZone उघडा.',
      bodyWithReason: '₹{amount} जोडण्याची तुमची विनंती नामंजूर झाली. कारण: {reason}',
    },
    withdrawal_approved: { title: 'पैसे पाठवले', body: '₹{amount} तुमच्या UPI ID वर पाठवले आहेत.' },
    withdrawal_rejected: {
      title: 'पैसे काढण्याची विनंती नामंजूर',
      body: '₹{amount} तुमच्या बॅलन्समध्ये परत आले आहेत. कारण पाहण्यासाठी BetZone उघडा.',
      bodyWithReason: '₹{amount} तुमच्या बॅलन्समध्ये परत आले आहेत. कारण: {reason}',
    },
    winnings: { title: 'तुम्ही जिंकलात! 🎉', body: 'जिंकलेले ₹{amount} तुमच्या बॅलन्समध्ये जोडले आहेत.' },
  },
};

const URLS: Record<PushKind, string> = {
  deposit_approved: '/?open=money',
  deposit_rejected: '/?open=money',
  withdrawal_approved: '/?open=money',
  withdrawal_rejected: '/?open=money',
  winnings: '/?open=bets',
};

export function formatRupees(amount: number): string {
  return Math.round(amount).toLocaleString('en-IN');
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '');
}

export function normalizeLanguage(value: string | null | undefined): PushLanguage {
  return value === 'hi' || value === 'mr' ? value : 'en';
}

export function buildMessage(kind: PushKind, amount: number, reason: string | null, language: PushLanguage): PushMessage {
  const template = TEXT[language][kind];
  const trimmedReason = reason?.trim().slice(0, 120) ?? '';
  const body = trimmedReason && template.bodyWithReason
    ? fill(template.bodyWithReason, { amount: formatRupees(amount), reason: trimmedReason })
    : fill(template.body, { amount: formatRupees(amount) });
  return { title: template.title, body, url: URLS[kind], tag: kind };
}

/**
 * One notification per event, except winnings: all of a player's payouts in
 * the batch (one result can pay many bets) become a single "You won ₹X".
 */
export function groupOutbox(rows: OutboxRow[]): Array<{ user_id: string; kind: PushKind; amount: number; reason: string | null }> {
  const out: Array<{ user_id: string; kind: PushKind; amount: number; reason: string | null }> = [];
  const winnings = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === 'winnings') {
      winnings.set(row.user_id, (winnings.get(row.user_id) ?? 0) + row.amount);
    } else {
      out.push({ user_id: row.user_id, kind: row.kind, amount: row.amount, reason: row.reason });
    }
  }
  for (const [user_id, amount] of winnings) {
    if (amount > 0) out.push({ user_id, kind: 'winnings', amount, reason: null });
  }
  return out;
}
