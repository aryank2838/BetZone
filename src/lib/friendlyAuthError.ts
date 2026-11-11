const EMAIL_UNAVAILABLE_MESSAGE = "This email address can't be used. Please use a different, permanent email.";
// Supabase Auth reports any failure in the signup triggers (blocked domain,
// duplicate inbox, missing terms metadata, ...) with this one message, so it
// must not claim that the email itself is the problem.
const SIGNUP_FAILED_MESSAGE = "We couldn't create your account. Try a different email or contact support.";

export function friendlyAuthError(message: string): string {
  const normalizedMessage = message.toLowerCase();
  if (normalizedMessage.includes('database error saving new user')) {
    return SIGNUP_FAILED_MESSAGE;
  }
  if (
    normalizedMessage.includes('already registered')
    || normalizedMessage.includes('already been registered')
    || normalizedMessage.includes('email_domain_blocked')
    || normalizedMessage.includes('email_already_used')
  ) {
    return EMAIL_UNAVAILABLE_MESSAGE;
  }
  if (normalizedMessage.includes('invalid login') || normalizedMessage.includes('invalid credentials')) {
    return 'Email or password is incorrect.';
  }
  if (normalizedMessage.includes('weak') || normalizedMessage.includes('easy to guess')) {
    return 'That password is too common or short. Use at least 8 characters.';
  }
  if (normalizedMessage.includes('unable to validate') || normalizedMessage.includes('invalid email')) {
    return 'Enter a valid email address.';
  }
  if (normalizedMessage.includes('rate limit') || normalizedMessage.includes('too many')) {
    return 'Too many attempts. Wait a moment and try again.';
  }
  if (normalizedMessage.includes('network') || normalizedMessage.includes('fetch')) {
    return 'Network problem. Check your connection and try again.';
  }
  return message;
}
