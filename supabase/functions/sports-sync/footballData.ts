// Converts football-data.org v4 matches into the shape sports_sync_upsert() expects.
// Pure functions only (no Deno or network), so they can be unit tested.

export interface SyncEvent {
  provider: string;
  provider_event_id: string;
  sport: 'football' | 'cricket';
  competition: string;
  competition_name: string;
  home_team: string;
  away_team: string;
  subject_side: 'home' | 'away';
  starts_at: string;
  status: 'scheduled' | 'live' | 'finished' | 'cancelled';
  home_score: string | null;
  away_score: string | null;
  winner: 'home' | 'away' | 'draw' | null;
}

interface FdTeam {
  name?: string | null;
  shortName?: string | null;
}

export interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam?: FdTeam | null;
  awayTeam?: FdTeam | null;
  competition?: { code?: string | null; name?: string | null } | null;
  score?: {
    winner?: string | null;
    fullTime?: { home?: number | null; away?: number | null } | null;
  } | null;
}

const STATUS: Record<string, SyncEvent['status']> = {
  SCHEDULED: 'scheduled',
  TIMED: 'scheduled',
  IN_PLAY: 'live',
  PAUSED: 'live',
  FINISHED: 'finished',
  AWARDED: 'finished',
  POSTPONED: 'cancelled',
  SUSPENDED: 'cancelled',
  CANCELLED: 'cancelled',
};

const WINNER: Record<string, SyncEvent['winner']> = {
  HOME_TEAM: 'home',
  AWAY_TEAM: 'away',
  DRAW: 'draw',
};

function teamName(team: FdTeam | null | undefined) {
  return (team?.shortName || team?.name || '').trim();
}

/** Returns null for matches we cannot use (unknown status, teams not decided yet). */
export function mapFootballMatch(match: FdMatch, fallbackCompetition: string): SyncEvent | null {
  const status = STATUS[match.status];
  const home = teamName(match.homeTeam);
  const away = teamName(match.awayTeam);
  if (!status || !home || !away || !match.utcDate) return null;

  const fullTime = match.score?.fullTime;
  const finished = status === 'finished';
  return {
    provider: 'football-data',
    provider_event_id: String(match.id),
    sport: 'football',
    competition: match.competition?.code || fallbackCompetition,
    competition_name: match.competition?.name || fallbackCompetition,
    home_team: home,
    away_team: away,
    subject_side: 'home',
    starts_at: match.utcDate,
    status,
    home_score: fullTime?.home == null ? null : String(fullTime.home),
    away_score: fullTime?.away == null ? null : String(fullTime.away),
    // The winner includes extra time and penalties when they were played.
    winner: finished ? WINNER[match.score?.winner ?? ''] ?? null : null,
  };
}

/** football-data.org allows at most a 10-day window: 3 days back, 6 ahead. */
export function syncWindow(now: Date) {
  const day = 24 * 60 * 60 * 1000;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(new Date(now.getTime() - 3 * day)), dateTo: fmt(new Date(now.getTime() + 6 * day)) };
}
