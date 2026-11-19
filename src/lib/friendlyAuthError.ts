import { translate } from '@/i18n/context';

/**
 * Turns a Supabase Auth error message into a short message in the player's
 * language. Unknown messages are returned unchanged.
 */
export function friendlyAuthError(message: string): string {
  const normalizedMessage = message.toLowerCase();
  // Supabase Auth reports any failure in the signup triggers (blocked domain,
  // duplicate inbox, missing terms metadata, ...) with this one message, so it
  // must not claim that the email itself is the problem.
  if (normalizedMessage.includes('database error saving new user')) {
    return translate('authErr.signupFailed');
  }
  if (
    normalizedMessage.includes('already registered')
    || normalizedMessage.includes('already been registered')
    || normalizedMessage.includes('email_domain_blocked')
    || normalizedMessage.includes('email_already_used')
  ) {
    return translate('authErr.emailUnavailable');
  }
  if (normalizedMessage.includes('invalid login') || normalizedMessage.includes('invalid credentials')) {
    return translate('authErr.wrongPassword');
  }
  if (normalizedMessage.includes('weak') || normalizedMessage.includes('easy to guess')) {
    return translate('authErr.weakPassword');
  }
  if (normalizedMessage.includes('unable to validate') || normalizedMessage.includes('invalid email')) {
    return translate('authErr.invalidEmail');
  }
  // verifyOtp() with a wrong, old or already-used code.
  if (
    normalizedMessage.includes('token has expired or is invalid')
    || normalizedMessage.includes('otp_expired')
    || normalizedMessage.includes('invalid otp')
  ) {
    return translate('authErr.codeInvalid');
  }
  if (
    normalizedMessage.includes('rate limit')
    || normalizedMessage.includes('too many')
    // "For security purposes, you can only request this after 42 seconds."
    || normalizedMessage.includes('for security purposes')
  ) {
    return translate('authErr.tooMany');
  }
  if (normalizedMessage.includes('network') || normalizedMessage.includes('fetch')) {
    return translate('authErr.network');
  }
  return message;
}
