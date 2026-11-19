/**
 * Spots common typos in the email domain ("gmial.com", "gmail.co") and
 * suggests the likely address. Only a suggestion: the player decides.
 */

/** Real providers players use. A typo is matched against these. */
const POPULAR_DOMAINS = [
  'gmail.com', 'yahoo.com', 'yahoo.in', 'yahoo.co.in', 'outlook.com', 'outlook.in',
  'hotmail.com', 'live.com', 'icloud.com', 'rediffmail.com', 'protonmail.com',
];

/** Real domains that look like a typo of a popular one; never "corrected". */
const OTHER_REAL_DOMAINS = [
  'mail.com', 'email.com', 'ymail.com', 'gmx.com', 'aol.com', 'me.com', 'mac.com',
  'zoho.com', 'yandex.com', 'proton.me', 'live.in', 'hotmail.co.uk', 'rocketmail.com',
];

const KNOWN = new Set([...POPULAR_DOMAINS, ...OTHER_REAL_DOMAINS]);

/** Edit distance where swapping two neighbouring letters counts as one edit. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** The corrected email, or null when the domain looks fine. */
export function suggestEmail(email: string): string | null {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (!domain.includes('.') || KNOWN.has(domain)) return null;

  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of POPULAR_DOMAINS) {
    const distance = editDistance(domain, candidate);
    // Longer names allow two slips ("gmal.co"); short ones only one.
    const allowed = candidate.length >= 9 ? 2 : 1;
    if (distance <= allowed && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best ? `${local}@${best}` : null;
}
