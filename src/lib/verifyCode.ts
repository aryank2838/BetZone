/** Digits only; Supabase email codes are 6 digits by default (up to 10 if changed). */
export function cleanCode(value: string) {
  return value.replace(/\D/g, '').slice(0, 10);
}
