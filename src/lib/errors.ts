import { friendlyAuthError } from '@/lib/friendlyAuthError';
import { translate } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n/context';

export type FriendlyErrorAction = 'add_funds' | 'login' | 'retry' | 'help';

export interface FriendlyError {
  message: string;
  action?: FriendlyErrorAction;
  key: TranslationKey;
}

const GENERIC_KEY: TranslationKey = 'errors.generic';

function mappedError(
  key: TranslationKey,
  action?: FriendlyErrorAction,
  values: Record<string, string> = {},
): FriendlyError {
  const message = translate(key).replace(/\{(\w+)\}/g, (placeholder, name: string) => values[name] ?? placeholder);
  return { message, action, key };
}

export function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return String(error ?? '');
}

export function friendlyError(error: unknown): FriendlyError {
  const raw = rawErrorMessage(error).replace(/^ERROR:\s*/i, '').trim();
  const message = raw.toLowerCase();

  if (/network|fetch failed|failed to fetch|load failed|networkerror/.test(message)) {
    return mappedError('errors.network', 'retry');
  }
  if (/not authenticated|jwt expired|invalid jwt/.test(message)) {
    return mappedError('errors.login', 'login');
  }
  if (/terms_not_accepted/.test(message)) {
    return mappedError('errors.terms', 'help');
  }
  if (/^insufficient wallet balance/.test(message)) {
    return mappedError('errors.insufficientWallet', 'help');
  }
  if (message === 'please accept the terms and privacy policy first.') {
    return mappedError('errors.termsRequired', 'help');
  }
  const cooldown = raw.match(/^Betting is paused until (.+) due to your cooldown\.$/i);
  if (cooldown) {
    return mappedError('errors.cooldown', 'help', { date: cooldown[1] });
  }
  const bettingExclusion = raw.match(/^Betting is unavailable until your self-exclusion ends on (.+?)\.?$/i);
  if (bettingExclusion) {
    return mappedError('errors.selfExclusionBetting', 'help', { date: bettingExclusion[1] });
  }
  const depositExclusion = raw.match(/^Deposits are unavailable until your self-exclusion ends on (.+?)\.?$/i);
  if (depositExclusion) {
    return mappedError('errors.selfExclusionDeposits', 'help', { date: depositExclusion[1] });
  }
  const dailyDeposit = raw.match(/^Daily deposit limit reached\. Limit: (.+?) points; today: (.+?) points\.?$/i);
  if (dailyDeposit) {
    return mappedError('errors.dailyDepositLimit', 'help', { limit: dailyDeposit[1], today: dailyDeposit[2] });
  }
  const dailyLoss = raw.match(/^Daily loss limit reached\. Limit: (.+?) points; today: (.+?) points\.?$/i);
  if (dailyLoss) {
    return mappedError('errors.dailyLossLimit', 'help', { limit: dailyLoss[1], today: dailyLoss[2] });
  }
  const withdrawalTurnover = raw.match(/^Wager (\d+) more points before withdrawing\./i);
  if (withdrawalTurnover) {
    return mappedError('errors.withdrawalTurnover', 'help', { points: withdrawalTurnover[1] });
  }
  if (/^Add at least 100 approved deposit points before requesting a withdrawal\.?$/i.test(raw)) {
    return mappedError('errors.depositRequirement', 'add_funds');
  }
  if (raw === 'Please try again.') {
    return mappedError('errors.retry', 'retry');
  }
  if (/insufficient .*balance|insufficient points|not enough balance/.test(message)) {
    return mappedError('errors.balance', 'add_funds');
  }
  if (/betting is closed|bets are closed/.test(message)) {
    return mappedError('errors.closed', 'retry');
  }
  if (/account is banned|user is banned|banned/.test(message)) {
    return mappedError('errors.banned', 'help');
  }
  if (/minimum withdrawal|withdrawal.*minimum|minimum.*withdraw/.test(message)) {
    return mappedError('errors.withdrawalMinimum', 'help');
  }
  if (/pending.*(request|withdrawal|add.?fund)|already pending|withdrawal awaiting|already have.*withdrawal/.test(message)) {
    return mappedError('errors.pending');
  }
  if (/invalid (number|digit|jodi|patti)|number must be|must be (one|two) digit|valid patti|whole number from 1 to|positive whole number/.test(message)) {
    return mappedError('errors.invalidNumber');
  }
  if (/payment reference.*(8 to 30|letters or numbers)|utr.*(invalid|format)/.test(message)) {
    return mappedError('errors.reference');
  }
  if (/limit exceeded|can total at most|maximum.*(points|amount)|exceed.*limit/.test(message)) {
    return mappedError('errors.limit');
  }

  const authMessage = friendlyAuthError(raw);
  if (authMessage !== raw) return { ...mappedError(GENERIC_KEY), message: authMessage };

  return mappedError(GENERIC_KEY);
}

export function friendlyErrorDetails(error: unknown): FriendlyError & { raw?: string } {
  const friendly = friendlyError(error);
  return {
    ...friendly,
    raw: friendly.key === GENERIC_KEY ? rawErrorMessage(error) : undefined,
  };
}
