import { describe, expect, it } from 'vitest';
import { friendlyError, friendlyErrorDetails, rawErrorMessage } from '@/lib/errors';
import { translate, type Language, type TranslationKey } from '@/i18n/context';

describe('friendlyError', () => {
  it.each([
    ['Insufficient balance. You have 2.', 'You do not have enough balance for these picks.', 'add_funds'],
    ['Betting is closed for this bet type right now.', 'Betting has closed for this bet type.', 'retry'],
    ['Your account is banned. Contact support.', 'Your account is restricted. Contact support for help.', 'help'],
    ['Minimum withdrawal amount is 100.', 'The withdrawal amount is below the minimum.', 'help'],
    ['A pending request already exists.', 'You already have a request being reviewed. Please wait for it to be processed.', undefined],
    ['Invalid number', 'Check the number and try again.', undefined],
    ['Payment reference must be 8 to 30 letters or numbers', 'Enter an 8–30 character payment reference using letters or numbers.', undefined],
    ['Round stake limit exceeded', 'This request exceeds the allowed limit. Reduce the amount and try again.', undefined],
    ['Not authenticated', 'Please sign in again to continue.', 'login'],
    ['Failed to fetch', 'Connection problem. Check your internet and try again.', 'retry'],
  ])('maps %s', (raw, message, action) => {
    const result = friendlyError(new Error(raw));
    expect(result.message).toBe(message);
    expect(result.action).toBe(action);
  });

  it('uses a generic message for unknown errors and exposes raw details separately', () => {
    const error = new Error('unexpected database failure');
    expect(friendlyError(error)).toMatchObject({
      message: 'Something went wrong. Please try again.',
      key: 'errors.generic',
    });
    expect(rawErrorMessage(error)).toBe('unexpected database failure');
    expect(friendlyErrorDetails(error)).toMatchObject({
      message: 'Something went wrong. Please try again.',
      raw: 'unexpected database failure',
    });
  });

  it.each([
    [
      'Betting is paused until 2026-11-10 18:00:00+05:30 due to your cooldown.',
      'errors.cooldown',
      { date: '2026-11-10 18:00:00+05:30' },
      'help',
    ],
    [
      'Betting is unavailable until your self-exclusion ends on 2026-11-17 00:00:00+05:30.',
      'errors.selfExclusionBetting',
      { date: '2026-11-17 00:00:00+05:30' },
      'help',
    ],
    [
      'Deposits are unavailable until your self-exclusion ends on 2026-11-17 00:00:00+05:30.',
      'errors.selfExclusionDeposits',
      { date: '2026-11-17 00:00:00+05:30' },
      'help',
    ],
    [
      'Daily deposit limit reached. Limit: 500 points; today: 300 points.',
      'errors.dailyDepositLimit',
      { limit: '500', today: '300' },
      'help',
    ],
    [
      'Daily loss limit reached. Limit: 1000 points; today: 250 points.',
      'errors.dailyLossLimit',
      { limit: '1000', today: '250' },
      'help',
    ],
    [
      'Please accept the Terms and Privacy Policy first.',
      'errors.termsRequired',
      {},
      'help',
    ],
    [
      'Insufficient wallet balance. You have 50, requested 100.',
      'errors.insufficientWallet',
      {},
      'help',
    ],
    [
      'Wager 75 more points before withdrawing. Required turnover: 100 points; completed: 25 points.',
      'errors.withdrawalTurnover',
      { points: '75' },
      'help',
    ],
    [
      'Add at least 100 approved deposit points before requesting a withdrawal.',
      'errors.depositRequirement',
      {},
      'add_funds',
    ],
    [
      'Please try again.',
      'errors.retry',
      {},
      'retry',
    ],
  ] as const)(
    'maps the server message %s in English, Hindi, and Marathi',
    (raw, key, values, action) => {
      for (const language of ['en', 'hi', 'mr'] as Language[]) {
        localStorage.setItem('betzone_language', language);
        const template = translate(key as TranslationKey, language);
        const expected = template.replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name as keyof typeof values] ?? placeholder);
        const result = friendlyError(new Error(raw));
        expect(result).toMatchObject({ key, message: expected, action });
        expect(result.message).not.toMatch(/\{\w+\}/);
      }
    },
  );
});
