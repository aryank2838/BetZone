/** Version of the Terms and Privacy Policy users accept. Bump when the legal text changes. */
export const TERMS_VERSION = '2026-11-10';

/**
 * The app asks for (re-)acceptance when the user never accepted or accepted an
 * older version. The server still lets anyone with a non-null terms_accepted_at
 * bet and deposit, so bumping TERMS_VERSION never locks users out server-side.
 * Keep TERMS_VERSION in sync with current_terms_version in internal_rule_constants().
 */
export function needsTermsAcceptance(profile: { terms_accepted_at?: string | null; terms_version?: string | null }): boolean {
  return !profile.terms_accepted_at || profile.terms_version !== TERMS_VERSION;
}
