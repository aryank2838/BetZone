// sports-sync: imports matches and results, then lets the database close
// betting, refund and pay out (sports_sync_upsert). Called every 10 minutes
// by pg_cron with the x-cron-secret header.
//
// Secrets (supabase secrets set ...):
//   SPORTS_CRON_SECRET     shared with the cron job (Vault: sports_cron_secret)
//   FOOTBALL_DATA_API_KEY  football-data.org key
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { mapFootballMatch, syncWindow, type FdMatch, type SyncEvent } from './footballData.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function fetchFootball(apiKey: string, competitions: string[]): Promise<SyncEvent[]> {
  const { dateFrom, dateTo } = syncWindow(new Date());
  const events: SyncEvent[] = [];
  for (const code of competitions) {
    const url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const res = await fetch(url, { headers: { 'X-Auth-Token': apiKey } });
    if (!res.ok) {
      throw new Error(`football-data ${code}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { matches?: FdMatch[] };
    for (const match of body.matches ?? []) {
      const event = mapFootballMatch(match, code);
      if (event) events.push(event);
    }
  }
  return events;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('SPORTS_CRON_SECRET') ?? '';
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!secret || !sameSecret(given, secret)) return json({ error: 'Unauthorized' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  );

  const { data: settings, error: settingsError } = await supabase
    .from('sport_settings')
    .select('football_competitions')
    .eq('id', 1)
    .single();
  if (settingsError || !settings) return json({ error: settingsError?.message ?? 'No settings' }, 500);

  const results: Record<string, unknown> = {};

  // Football always syncs once the key is set: matches are ready in the admin
  // screen before betting is switched on (players cannot see or bet on them
  // while it is off), and open bets still settle if it is switched off later.
  const footballKey = Deno.env.get('FOOTBALL_DATA_API_KEY');
  if (footballKey) {
    try {
      const events = await fetchFootball(footballKey, settings.football_competitions ?? []);
      const { data, error } = await supabase.rpc('sports_sync_upsert', { p_events: events });
      if (error) throw new Error(error.message);
      await supabase.rpc('sports_sync_record', { p_sport: 'football', p_ok: true, p_error: null, p_events_seen: events.length });
      results.football = data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await supabase.rpc('sports_sync_record', { p_sport: 'football', p_ok: false, p_error: message, p_events_seen: null });
      results.football = { error: message };
    }
  } else {
    results.football = 'no api key';
  }

  return json(results);
});
