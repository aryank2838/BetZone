// sports-sync: imports matches and results, then lets the database close
// betting, refund and pay out (sports_sync_upsert). Called every 10 minutes
// by pg_cron with the x-cron-secret header.
//
// Secrets:
//   SPORTS_CRON_SECRET     function secret, shared with the cron job (Vault: sports_cron_secret)
//   FOOTBALL_DATA_API_KEY  function secret, football-data.org key
//   cricket_api_key        Vault secret, cricketdata.org key (100 calls a day on the free plan)
//
// Cricket leagues come from sport_settings.cricket_leagues (India, IPL, WBBL, BBL, WPL).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// cricketdata.org resets connections from the Edge Function network, so cricket
// requests are sent by the database (pg_net): each run collects the replies to
// last run's requests, then queues the requests that are due now.
//
// Football and cricket always sync once their key is set, so matches are ready
// in the admin screen before betting is switched on (players cannot see or bet
// on them while it is off), and open bets still settle if it is switched off.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { mapFootballMatch, syncWindow, type FdMatch, type SyncEvent } from './footballData.ts';
import {
  isCricketLeague, isSeriesInWindow, leagueSearches, mapCricketMatch, nextCricketCheck, parseSeriesDate, seriesLeague,
  type CricketLeague, type CricMatch, type CricSeries,
} from './cricketData.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Stop queuing cricketdata.org calls for the day at this many (limit is 100). */
const CRICKET_DAILY_STOP = 90;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const rawErrorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Removes any API key from a message before it is stored or returned. */
function scrub(message: string) {
  let out = message.replace(/apikey=[^&\s)"']+/gi, 'apikey=***');
  for (const name of ['CRICKET_API_KEY', 'FOOTBALL_DATA_API_KEY']) {
    const value = Deno.env.get(name);
    if (value) out = out.split(value).join('***');
  }
  return out;
}

/** Error text with any API key removed. */
const errorText = (err: unknown) => scrub(rawErrorText(err));

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

interface CricReply<T> {
  status_code: number | null;
  error: string | null;
  body: { status?: string; reason?: string; data?: T; info?: { hitsToday?: number } } | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FeedRequest { request_id: number; kind: 'discovery' | 'series'; ref: string; created_at: string }

async function syncCricket(supabase: SupabaseClient, leagues: CricketLeague[]) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const problems: string[] = [];
  const events: SyncEvent[] = [];
  let collected = 0;
  let queued = 0;

  const { data: series, error: seriesError } = await supabase
    .from('sport_feed_series').select('series_id, name').eq('provider', 'cricketdata');
  if (seriesError) throw new Error(seriesError.message);
  const seriesName = new Map((series ?? []).map((s) => [s.series_id as string, s.name as string]));

  // Matches still open or waiting for payout, by series: they decide how often a series is checked.
  const { data: active } = await supabase
    .from('sport_events').select('competition, provider_event_id, state')
    .eq('sport', 'cricket').in('state', ['open', 'closed']);
  const unpaid = new Set((active ?? []).map((e) => e.provider_event_id as string));

  const { data: hitsRow } = await supabase.from('sport_feed_state').select('at, value').eq('key', 'cricket_hits').maybeSingle();
  let hitsToday = hitsRow && hitsRow.at.slice(0, 10) === nowIso.slice(0, 10) ? hitsRow.value ?? 0 : 0;

  /** Reads the replies that have arrived. Returns the requests still waiting. */
  const collect = async (requests: FeedRequest[], giveUp: boolean): Promise<FeedRequest[]> => {
    const waiting: FeedRequest[] = [];
    for (const req of requests) {
      const { data, error } = await supabase.rpc('cricket_http_result', { p_request_id: req.request_id });
      if (error) throw new Error(error.message);
      const reply = data as CricReply<unknown> | null;
      if (!reply) {
        // Not back yet. Give up after 30 minutes; it is queued again when due.
        if (giveUp && Date.now() - Date.parse(req.created_at) > 30 * MINUTE) {
          await supabase.from('sport_feed_requests').delete().eq('request_id', req.request_id);
          problems.push(`cricketdata ${req.kind}: no reply`);
        } else {
          waiting.push(req);
        }
        continue;
      }
      await supabase.from('sport_feed_requests').delete().eq('request_id', req.request_id);
      const body = reply.body;
      if (reply.status_code !== 200 || !body || body.status !== 'success') {
        problems.push(scrub(`cricketdata ${req.kind}: ${reply.error ?? body?.reason ?? `HTTP ${reply.status_code}`}`));
        continue;
      }
      hitsToday = Math.max(hitsToday, body.info?.hitsToday ?? 0);
      collected += 1;

      if (req.kind === 'discovery') {
        const rows = ((body.data as CricSeries[] | undefined) ?? [])
          .filter((s) => seriesLeague(s.name, leagues) !== null && isSeriesInWindow(s, now))
          .map((s) => {
            const start = parseSeriesDate(s.startDate, null);
            const end = parseSeriesDate(s.endDate, start);
            seriesName.set(s.id, s.name);
            return {
              provider: 'cricketdata',
              series_id: s.id,
              name: s.name.slice(0, 120),
              start_date: start === null ? null : new Date(start).toISOString().slice(0, 10),
              end_date: end === null ? null : new Date(end).toISOString().slice(0, 10),
            };
          });
        if (rows.length) {
          const { error: upsertError } = await supabase.from('sport_feed_series').upsert(rows, { onConflict: 'provider,series_id' });
          if (upsertError) throw new Error(upsertError.message);
        }
      } else {
        const ref = { id: req.ref, name: seriesName.get(req.ref) ?? req.ref };
        const matches = (body.data as { matchList?: CricMatch[] } | undefined)?.matchList ?? [];
        for (const match of matches) {
          const event = mapCricketMatch(match, ref);
          if (event) events.push(event);
        }
        const next = nextCricketCheck(matches, ref, Date.now(), unpaid);
        await supabase.from('sport_feed_series')
          .update({ next_check_at: new Date(next).toISOString() })
          .eq('provider', 'cricketdata').eq('series_id', req.ref);
      }
    }
    return waiting;
  };

  // 1. Replies to requests sent in earlier runs.
  const { data: pending, error: pendingError } = await supabase.from('sport_feed_requests').select('*');
  if (pendingError) throw new Error(pendingError.message);
  const stillPending = await collect((pending ?? []) as FeedRequest[], true);

  // 2. Send what is due now.
  const pendingRefs = new Set(stillPending.map((p) => `${p.kind}:${p.ref}`));
  const sent: FeedRequest[] = [];
  const queue = async (kind: 'discovery' | 'series', ref: string, path: string, params: Record<string, string>) => {
    if (hitsToday + queued >= CRICKET_DAILY_STOP || pendingRefs.has(`${kind}:${ref}`)) return false;
    const { data: requestId, error } = await supabase.rpc('cricket_http_get', { p_path: path, p_params: params });
    if (error) throw new Error(error.message);
    const { error: insertError } = await supabase.from('sport_feed_requests').insert({ request_id: requestId, kind, ref });
    if (insertError) throw new Error(insertError.message);
    sent.push({ request_id: requestId as number, kind, ref, created_at: new Date().toISOString() });
    queued += 1;
    return true;
  };

  // Twice a day, look for the chosen leagues' series.
  const { data: discovery } = await supabase.from('sport_feed_state').select('at').eq('key', 'cricket_discovery').maybeSingle();
  if (!discovery || now - Date.parse(discovery.at) > 12 * HOUR) {
    let all = true;
    for (const search of leagueSearches(leagues)) {
      if (!await queue('discovery', search, 'series', { offset: '0', search })) all = false;
    }
    if (all) await supabase.from('sport_feed_state').upsert({ key: 'cricket_discovery', at: nowIso });
  }

  // Each series when its next check is due (see nextCricketCheck), at least every 6 hours.
  const { data: current, error: currentError } = await supabase
    .from('sport_feed_series').select('series_id, name, start_date, end_date, last_fetched_at, next_check_at').eq('provider', 'cricketdata');
  if (currentError) throw new Error(currentError.message);
  for (const s of current ?? []) {
    const mine = (active ?? []).filter((e) => e.competition === s.series_id);
    const end = s.end_date ? Date.parse(s.end_date) : null;
    const start = s.start_date ? Date.parse(s.start_date) : null;
    if (end !== null && end < now - 3 * DAY && mine.length === 0) {
      await supabase.from('sport_feed_series').delete().eq('provider', 'cricketdata').eq('series_id', s.series_id);
      continue;
    }
    if (start !== null && start > now + 8 * DAY) continue;
    // A league switched off stops syncing, except for matches that still have bets to settle.
    if (seriesLeague(s.name, leagues) === null && mine.length === 0) continue;
    const due = !s.next_check_at || now >= Date.parse(s.next_check_at)
      || !s.last_fetched_at || now - Date.parse(s.last_fetched_at) >= 6 * HOUR;
    if (!due) continue;
    if (await queue('series', s.series_id, 'series_info', { id: s.series_id })) {
      await supabase.from('sport_feed_series')
        .update({ last_fetched_at: nowIso })
        .eq('provider', 'cricketdata').eq('series_id', s.series_id);
    }
  }

  // 3. Replies usually arrive within about 20 seconds: read them now instead of next run.
  let waiting = sent;
  for (let attempt = 0; attempt < 10 && waiting.length; attempt += 1) {
    await sleep(4000);
    waiting = await collect(waiting, false);
  }
  await supabase.from('sport_feed_state').upsert({ key: 'cricket_hits', at: nowIso, value: hitsToday });

  // 4. Hand the matches to the database.
  let result: Record<string, unknown> = {};
  if (events.length) {
    const { data, error } = await supabase.rpc('sports_sync_upsert', { p_events: events });
    if (error) throw new Error(error.message);
    result = data as Record<string, unknown>;
  }
  return {
    events: events.length,
    problems,
    result: { ...result, replies_read: collected, requests_sent: queued, calls_today: Math.max(hitsToday, 0) },
  };
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
    .select('football_competitions, cricket_leagues')
    .eq('id', 1)
    .single();
  if (settingsError || !settings) return json({ error: settingsError?.message ?? 'No settings' }, 500);

  const results: Record<string, unknown> = {};

  // Football and cricket run separately, so a problem with one never stops the other.
  const footballKey = Deno.env.get('FOOTBALL_DATA_API_KEY');
  if (footballKey) {
    try {
      const events = await fetchFootball(footballKey, settings.football_competitions ?? []);
      const { data, error } = await supabase.rpc('sports_sync_upsert', { p_events: events });
      if (error) throw new Error(error.message);
      await supabase.rpc('sports_sync_record', { p_sport: 'football', p_ok: true, p_error: null, p_events_seen: events.length });
      results.football = data;
    } catch (err) {
      await supabase.rpc('sports_sync_record', { p_sport: 'football', p_ok: false, p_error: errorText(err), p_events_seen: null });
      results.football = { error: errorText(err) };
    }
  } else {
    results.football = 'no api key';
  }

  try {
    const cricket = await syncCricket(supabase, ((settings.cricket_leagues ?? []) as string[]).filter(isCricketLeague));
    const problem = cricket.problems.length ? cricket.problems.join('; ').slice(0, 480) : null;
    // Most runs read nothing (no series due), so keep the last count then.
    await supabase.rpc('sports_sync_record', {
      p_sport: 'cricket', p_ok: !problem, p_error: problem, p_events_seen: cricket.events || null,
    });
    results.cricket = problem ? { ...cricket.result, problems: cricket.problems } : cricket.result;
  } catch (err) {
    await supabase.rpc('sports_sync_record', { p_sport: 'cricket', p_ok: false, p_error: errorText(err), p_events_seen: null });
    results.cricket = { error: errorText(err) };
  }

  return json(results);
});
