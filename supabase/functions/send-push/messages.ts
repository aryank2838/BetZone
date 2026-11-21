// Notification text in the player's language. Kept short: phones cut
// titles at about 40 characters and bodies at about 2 lines.

export type PushKind =
  | 'deposit_approved'
  | 'deposit_rejected'
  | 'withdrawal_approved'
  | 'withdrawal_rejected'
  | 'winnings'
  | 'match_starting'
  | 'referral_bonus'
  // Admin alerts. For admin_waiting, amount is the number of waiting
  // requests and reason is how many minutes the oldest has waited.
  | 'admin_deposit'
  | 'admin_withdrawal'
  | 'admin_waiting'
  | 'admin_test';

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
    match_starting: {
      title: 'Your match starts soon',
      body: 'A match you bet ₹{amount} on starts soon.',
      bodyWithReason: '{reason} starts soon. You have ₹{amount} on it.',
    },
    referral_bonus: {
      title: 'Referral bonus 🎉',
      body: 'A friend you invited added money. ₹{amount} bonus is in your play balance.',
      bodyWithReason: '{reason} added money. ₹{amount} bonus is in your play balance.',
    },
    admin_deposit: {
      title: 'New add-money request',
      body: '₹{amount} to add. Tap to review.',
      bodyWithReason: '{reason} wants to add ₹{amount}. Tap to review.',
    },
    admin_withdrawal: {
      title: 'New withdrawal request',
      body: '₹{amount} to withdraw. Tap to review.',
      bodyWithReason: '{reason} wants to withdraw ₹{amount}. Tap to review.',
    },
    admin_waiting: {
      title: 'Requests are waiting',
      body: '{count} requests are waiting for you.',
      bodyWithReason: '{count} waiting · oldest for {reason} min. Tap to review.',
    },
    admin_test: { title: 'Admin alerts are working ✅', body: 'You will get a notification like this for every new request.' },
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
    match_starting: {
      title: 'आपका मैच जल्द शुरू होगा',
      body: 'जिस मैच पर आपने ₹{amount} की बेट लगाई है, वह जल्द शुरू होगा।',
      bodyWithReason: '{reason} जल्द शुरू होगा। इस पर आपके ₹{amount} लगे हैं।',
    },
    referral_bonus: {
      title: 'रेफ़रल बोनस 🎉',
      body: 'आपके बुलाए दोस्त ने पैसे जोड़े। ₹{amount} बोनस आपके प्ले बैलेंस में जुड़ गया है।',
      bodyWithReason: '{reason} ने पैसे जोड़े। ₹{amount} बोनस आपके प्ले बैलेंस में जुड़ गया है।',
    },
    admin_deposit: {
      title: 'पैसे जोड़ने का नया अनुरोध',
      body: '₹{amount} जोड़ने का अनुरोध। देखने के लिए टैप करें।',
      bodyWithReason: '{reason} ₹{amount} जोड़ना चाहते हैं। देखने के लिए टैप करें।',
    },
    admin_withdrawal: {
      title: 'निकासी का नया अनुरोध',
      body: '₹{amount} निकालने का अनुरोध। देखने के लिए टैप करें।',
      bodyWithReason: '{reason} ₹{amount} निकालना चाहते हैं। देखने के लिए टैप करें।',
    },
    admin_waiting: {
      title: 'अनुरोध इंतज़ार में हैं',
      body: '{count} अनुरोध आपका इंतज़ार कर रहे हैं।',
      bodyWithReason: '{count} अनुरोध इंतज़ार में · सबसे पुराना {reason} मिनट से। देखने के लिए टैप करें।',
    },
    admin_test: { title: 'एडमिन अलर्ट चालू हैं ✅', body: 'हर नए अनुरोध पर आपको ऐसा नोटिफ़िकेशन मिलेगा।' },
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
    match_starting: {
      title: 'तुमचा सामना लवकरच सुरू होईल',
      body: 'ज्या सामन्यावर तुम्ही ₹{amount} ची बेट लावली आहे, तो लवकरच सुरू होईल.',
      bodyWithReason: '{reason} लवकरच सुरू होईल. यावर तुमचे ₹{amount} लागले आहेत.',
    },
    referral_bonus: {
      title: 'रेफरल बोनस 🎉',
      body: 'तुम्ही बोलावलेल्या मित्राने पैसे जोडले. ₹{amount} बोनस तुमच्या प्ले बॅलन्समध्ये जोडला आहे.',
      bodyWithReason: '{reason} ने पैसे जोडले. ₹{amount} बोनस तुमच्या प्ले बॅलन्समध्ये जोडला आहे.',
    },
    admin_deposit: {
      title: 'पैसे जोडण्याची नवी विनंती',
      body: '₹{amount} जोडण्याची विनंती. पाहण्यासाठी टॅप करा.',
      bodyWithReason: '{reason} यांना ₹{amount} जोडायचे आहेत. पाहण्यासाठी टॅप करा.',
    },
    admin_withdrawal: {
      title: 'पैसे काढण्याची नवी विनंती',
      body: '₹{amount} काढण्याची विनंती. पाहण्यासाठी टॅप करा.',
      bodyWithReason: '{reason} यांना ₹{amount} काढायचे आहेत. पाहण्यासाठी टॅप करा.',
    },
    admin_waiting: {
      title: 'विनंत्या वाट पाहत आहेत',
      body: '{count} विनंत्या तुमची वाट पाहत आहेत.',
      bodyWithReason: '{count} विनंत्या प्रलंबित · सर्वात जुनी {reason} मिनिटांपासून. पाहण्यासाठी टॅप करा.',
    },
    admin_test: { title: 'अ‍ॅडमिन अलर्ट सुरू आहेत ✅', body: 'प्रत्येक नव्या विनंतीसाठी तुम्हाला असे नोटिफिकेशन येईल.' },
  },
};

const URLS: Record<PushKind, string> = {
  deposit_approved: '/?open=money',
  deposit_rejected: '/?open=money',
  withdrawal_approved: '/?open=money',
  withdrawal_rejected: '/?open=money',
  winnings: '/?open=bets',
  match_starting: '/?open=sports',
  referral_bonus: '/?open=money',
  admin_deposit: '/?open=admin-requests',
  admin_withdrawal: '/?open=admin-requests',
  admin_waiting: '/?open=admin-requests',
  admin_test: '/?open=admin-requests',
};

/** How long a push service keeps trying to deliver, by kind. */
export function ttlSeconds(kind: PushKind): number {
  // A match reminder is useless after kick-off; a "still waiting" reminder is
  // replaced by the next one 30 minutes later.
  if (kind === 'match_starting' || kind === 'admin_waiting' || kind === 'admin_test') return 30 * 60;
  if (kind === 'winnings' || kind === 'admin_deposit' || kind === 'admin_withdrawal') return 6 * 60 * 60;
  return 24 * 60 * 60;
}

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
  const values = { amount: formatRupees(amount), count: String(Math.max(0, Math.round(amount))), reason: trimmedReason };
  const body = trimmedReason && template.bodyWithReason
    ? fill(template.bodyWithReason, values)
    : fill(template.body, values);
  // One reminder per match, and one notification per new request, so they do
  // not replace each other. "Still waiting" reminders replace the last one.
  let tag: string = kind;
  if (kind === 'match_starting' && trimmedReason) tag = `${kind}:${trimmedReason}`;
  if (kind === 'admin_deposit' || kind === 'admin_withdrawal') tag = `${kind}:${trimmedReason}:${amount}`;
  return { title: template.title, body, url: URLS[kind], tag };
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
