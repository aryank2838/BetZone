// Converts cricketdata.org (CricAPI v1) data into the shape sports_sync_upsert()
// expects. Pure functions only (no Deno or network), so they can be unit tested.
import type { SyncEvent } from './footballData.ts';

export interface CricSeries {
  id: string;
  name: string;
  startDate?: string | null;
  endDate?: string | null;
  matches?: number | null;
}

export interface CricMatch {
  id: string;
  name?: string | null;
  matchType?: string | null;
  status?: string | null;
  dateTimeGMT?: string | null;
  teams?: string[] | null;
  matchStarted?: boolean | null;
  matchEnded?: boolean | null;
}

/** In India series only India's matches are offered. */
const OUR_TEAMS = new Set(['india', 'india women']);
const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export type CricketLeague = 'india' | 'ipl' | 'wbbl' | 'bbl' | 'wpl';

/**
 * Leagues the admin can switch on. `search` is the cricketdata.org series
 * search; in a league (not 'india') every match is offered.
 */
export const CRICKET_LEAGUES: Record<CricketLeague, { search: string; matches: (name: string) => boolean }> = {
  india: {
    search: 'India',
    // India senior series (men or women). Skips A teams, youth and veterans cricket.
    matches: (name) => /\bindia\b/i.test(name)
      && !/\bU-?19\b|\bU-?23\b|\bA\b|\bemerging\b|\blegends\b|\bmasters\b/i.test(name),
  },
  ipl: { search: 'Indian Premier League', matches: (name) => /indian premier league/i.test(name) },
  wbbl: { search: 'Big Bash', matches: (name) => /women'?s big bash/i.test(name) },
  bbl: { search: 'Big Bash', matches: (name) => /big bash league/i.test(name) && !/women/i.test(name) },
  wpl: { search: 'Womens Premier League', matches: (name) => /women'?s premier league/i.test(name) && !/indian/i.test(name) },
};

export function isCricketLeague(value: string): value is CricketLeague {
  return Object.prototype.hasOwnProperty.call(CRICKET_LEAGUES, value);
}

/** The league a series belongs to, among the given ones, or null. */
export function seriesLeague(name: string, leagues: readonly CricketLeague[]): CricketLeague | null {
  return leagues.find((league) => CRICKET_LEAGUES[league].matches(name)) ?? null;
}

/** Series searches needed for these leagues (WBBL and BBL share one). */
export function leagueSearches(leagues: readonly CricketLeague[]): string[] {
  return [...new Set(leagues.map((league) => CRICKET_LEAGUES[league].search))];
}

const ALL_LEAGUES = Object.keys(CRICKET_LEAGUES) as CricketLeague[];

/** "2026-12-13", or "Dec 27" (year missing) resolved relative to the start date. */
export function parseSeriesDate(value: string | null | undefined, startMs: number | null): number | null {
  if (!value) return null;
  const iso = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (/^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(iso)) return iso;
  const m = value.trim().match(/^([A-Za-z]{3})\w*\s+(\d{1,2})$/);
  if (!m || startMs === null) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const startYear = new Date(startMs).getUTCFullYear();
  let ms = Date.UTC(startYear, month, Number(m[2]));
  if (ms < startMs) ms = Date.UTC(startYear + 1, month, Number(m[2]));
  return ms;
}

/** Series that may have a match between 3 days ago and 8 days ahead. */
export function isSeriesInWindow(series: CricSeries, nowMs: number) {
  const start = parseSeriesDate(series.startDate, null);
  if (start === null) return false;
  const end = parseSeriesDate(series.endDate, start) ?? start + 90 * DAY;
  return start <= nowMs + 8 * DAY && end >= nowMs - 3 * DAY;
}

/** Earliest of dateTimeGMT and "Match starts at Nov 18, 22:00 GMT" in the status. */
export function cricketStartMs(match: CricMatch): number | null {
  const gmt = match.dateTimeGMT ? Date.parse(`${match.dateTimeGMT.replace(/Z$/, '')}Z`) : Number.NaN;
  const base = Number.isFinite(gmt) ? gmt : null;
  const m = (match.status ?? '').match(/starts at ([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*GMT/i);
  let fromStatus: number | null = null;
  if (m && base !== null) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) {
      const year = new Date(base).getUTCFullYear();
      // Pick the year that puts the status date closest to dateTimeGMT (handles Dec/Jan).
      const candidates = [year - 1, year, year + 1].map((y) => Date.UTC(y, month, Number(m[2]), Number(m[3]), Number(m[4])));
      fromStatus = candidates.reduce((best, c) => (Math.abs(c - base) < Math.abs(best - base) ? c : best));
    }
  }
  if (base === null) return fromStatus;
  return fromStatus === null ? base : Math.min(base, fromStatus);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Reads the result from the status text. Returns 'cancelled' for no result,
 * or null when the text is not understood (then nothing is paid automatically).
 */
export function cricketResult(status: string, teams: [string, string]): 'home' | 'away' | 'draw' | 'cancelled' | null {
  const text = status.trim();
  const side = (name: string): 'home' | 'away' | null => {
    const n = norm(name);
    if (n === norm(teams[0])) return 'home';
    if (n === norm(teams[1])) return 'away';
    return null;
  };
  if (/\bno result\b|\babandoned\b|\bcancell?ed\b|\bcalled off\b|\bpostponed\b/i.test(text)) return 'cancelled';
  const superOver = text.match(/\(?\s*(.+?) won the (?:super over|one-over eliminator)/i);
  if (/\bmatch tied\b/i.test(text)) {
    if (superOver) return side(superOver[1].replace(/^.*\(\s*/, '')) ?? null;
    return 'draw';
  }
  if (/\bmatch drawn\b|^drawn\b/i.test(text)) return 'draw';
  const won = text.match(/^(.+?) won\b/i);
  if (won) return side(won[1]);
  return null;
}

/** Converts one series match. Returns null for matches we do not offer or cannot use. */
export function mapCricketMatch(match: CricMatch, series: { id: string; name: string }): SyncEvent | null {
  const teams = match.teams ?? [];
  if (teams.length !== 2 || teams.some((t) => !t || /^tbc$|^tba$/i.test(t.trim()))) return null;
  const home = teams[0].trim();
  const away = teams[1].trim();
  const league = seriesLeague(series.name, ALL_LEAGUES);
  if (!league) return null;
  // In a league every match is offered and the question is about the home team.
  const allMatches = league !== 'india';
  const homeOurs = OUR_TEAMS.has(norm(home));
  const awayOurs = OUR_TEAMS.has(norm(away));
  if (!allMatches && !homeOurs && !awayOurs) return null;
  const startMs = cricketStartMs(match);
  if (startMs === null) return null;

  let status: SyncEvent['status'] = 'scheduled';
  let winner: SyncEvent['winner'] = null;
  if (match.matchEnded) {
    const result = cricketResult(match.status ?? '', [home, away]);
    if (result === 'cancelled') status = 'cancelled';
    else { status = 'finished'; winner = result; }
  } else if (match.matchStarted) {
    status = 'live';
  } else if (/\babandoned\b|\bcancell?ed\b|\bpostponed\b/i.test(match.status ?? '')) {
    status = 'cancelled';
  }

  return {
    provider: 'cricketdata',
    provider_event_id: match.id,
    sport: 'cricket',
    competition: series.id,
    competition_name: series.name,
    home_team: home,
    away_team: away,
    subject_side: !allMatches && awayOurs && !homeOurs ? 'away' : 'home',
    starts_at: new Date(startMs).toISOString(),
    status,
    home_score: null,
    away_score: null,
    winner,
  };
}

export type CricketFormat = 't10' | 't20' | 'odi' | 'test';

/** Match format from matchType, or from the match name when matchType is missing. */
export function cricketFormat(match: Pick<CricMatch, 'matchType' | 'name'>): CricketFormat {
  const type = (match.matchType ?? '').toLowerCase();
  if (type === 't10' || type === 't20' || type === 'odi' || type === 'test') return type;
  const name = match.name ?? '';
  if (/\btest\b/i.test(name)) return 'test';
  if (/\bODI\b|one[- ]day|\b50[- ]over/i.test(name)) return 'odi';
  if (/\bT10\b/i.test(name)) return 't10';
  return 't20';
}

const MIN = 60 * 1000;
const HR = 60 * MIN;

/** Shortest time a match of this format usually takes, from the start. */
const EARLIEST_FINISH: Record<CricketFormat, number> = {
  t10: 75 * MIN,
  t20: 2.75 * HR,
  odi: 6.5 * HR,
  test: 3 * DAY,
};

/**
 * When a series' fixtures should next be fetched, so results are seen soon
 * after a match ends without spending the 100 free calls a day:
 * - before the start: every 6 hours, hourly in the last 2 hours (start-time changes);
 * - during a match: every 2 hours until it could be finishing, then every
 *   15 minutes (Tests every 30 minutes);
 * - a finished match not yet paid: 15 minutes later (second sighting of the result).
 * `unpaid` holds match ids that are still open or closed in the database.
 */
export function nextCricketCheck(matches: CricMatch[], series: { id: string; name: string }, nowMs: number, unpaid: Set<string>): number {
  let next = nowMs + 6 * HR;
  for (const match of matches) {
    const event = mapCricketMatch(match, series);
    if (!event) continue;
    const startMs = Date.parse(event.starts_at);
    let at: number;
    if (event.status === 'finished' || event.status === 'cancelled') {
      if (!unpaid.has(match.id)) continue;
      at = nowMs + 15 * MIN;
    } else if (event.status === 'scheduled') {
      at = startMs - nowMs > 2 * HR ? Math.min(startMs - 2 * HR, nowMs + 6 * HR) : nowMs + HR;
    } else {
      const format = cricketFormat(match);
      const finishFrom = startMs + EARLIEST_FINISH[format];
      const often = format === 'test' ? 30 * MIN : 15 * MIN;
      at = nowMs >= finishFrom ? nowMs + often : Math.min(finishFrom, nowMs + 2 * HR);
    }
    next = Math.min(next, Math.max(at, nowMs + 15 * MIN));
  }
  return next;
}
