import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() ?? '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() ?? '';

/** Names of required build-time variables that are missing. */
export const missingSupabaseConfig: string[] = [
  ...(url ? [] : ['VITE_SUPABASE_URL']),
  ...(anonKey ? [] : ['VITE_SUPABASE_ANON_KEY']),
];
export const supabaseConfigured = missingSupabaseConfig.length === 0;

// When configuration is missing, main.tsx renders a "not configured" page and
// never mounts the app. The inert client below only keeps imports from throwing;
// it persists nothing and never refreshes tokens.
export const supabase = supabaseConfigured
  ? createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })
  : createClient('https://not-configured.invalid', 'not-configured', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
