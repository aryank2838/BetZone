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
  status?: string | null;
  dateTimeGMT?: string | null;
  teams?: string[] | null;
  matchStarted?: boolean | null;
  matchEnded?: boolean | null;
}

/** Teams whose matches we offer, plus every IPL match. */
const OUR_TEAMS = new Set(['india', 'india women']);
const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function isIplSeries(name: string) {
  return /indian premier league/i.test(name);
}

/** India (men or women) senior series and the IPL. Skips A teams and youth cricket. */
export function isWantedSeries(name: string) {
  if (isIplSeries(name)) return true;
  if (!/\bindia\b/i.test(name)) return false;
  return !/\bU-?19\b|\bU-?23\b|\bA\b|\bemerging\b|\blegends\b|\bmasters\b/i.test(name);
}

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
  const ipl = isIplSeries(series.name);
  const homeOurs = OUR_TEAMS.has(norm(home));
  const awayOurs = OUR_TEAMS.has(norm(away));
  if (!ipl && !homeOurs && !awayOurs) return null;
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
    subject_side: !ipl && awayOurs && !homeOurs ? 'away' : 'home',
    starts_at: new Date(startMs).toISOString(),
    status,
    home_score: null,
    away_score: null,
    winner,
  };
}
