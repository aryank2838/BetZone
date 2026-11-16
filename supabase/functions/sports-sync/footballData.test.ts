import { describe, expect, it } from 'vitest';
import { mapFootballMatch, syncWindow, type FdMatch } from './footballData';

const base: FdMatch = {
  id: 501,
  utcDate: '2026-11-22T15:00:00Z',
  status: 'TIMED',
  homeTeam: { name: 'Arsenal FC', shortName: 'Arsenal' },
  awayTeam: { name: 'Chelsea FC', shortName: 'Chelsea' },
  competition: { code: 'PL', name: 'Premier League' },
  score: { winner: null, fullTime: { home: null, away: null } },
};

describe('mapFootballMatch', () => {
  it('maps an upcoming match', () => {
    expect(mapFootballMatch(base, 'PL')).toEqual({
      provider: 'football-data',
      provider_event_id: '501',
      sport: 'football',
      competition: 'PL',
      competition_name: 'Premier League',
      home_team: 'Arsenal',
      away_team: 'Chelsea',
      subject_side: 'home',
      starts_at: '2026-11-22T15:00:00Z',
      status: 'scheduled',
      home_score: null,
      away_score: null,
      winner: null,
    });
  });

  it('maps a finished match with its winner and score', () => {
    const event = mapFootballMatch(
      { ...base, status: 'FINISHED', score: { winner: 'AWAY_TEAM', fullTime: { home: 0, away: 2 } } },
      'PL',
    );
    expect(event).toMatchObject({ status: 'finished', winner: 'away', home_score: '0', away_score: '2' });
  });

  it('maps a draw and ignores a winner while the match is live', () => {
    expect(mapFootballMatch({ ...base, status: 'FINISHED', score: { winner: 'DRAW', fullTime: { home: 1, away: 1 } } }, 'PL')?.winner).toBe('draw');
    expect(mapFootballMatch({ ...base, status: 'IN_PLAY', score: { winner: 'HOME_TEAM', fullTime: { home: 1, away: 0 } } }, 'PL'))
      .toMatchObject({ status: 'live', winner: null });
  });

  it('treats postponed, suspended and cancelled matches as cancelled', () => {
    for (const status of ['POSTPONED', 'SUSPENDED', 'CANCELLED']) {
      expect(mapFootballMatch({ ...base, status }, 'PL')?.status).toBe('cancelled');
    }
  });

  it('skips matches with unknown status or undecided teams', () => {
    expect(mapFootballMatch({ ...base, status: 'SOMETHING_NEW' }, 'PL')).toBeNull();
    expect(mapFootballMatch({ ...base, awayTeam: { name: null } }, 'CL')).toBeNull();
  });
});

describe('syncWindow', () => {
  it('covers 3 days back and 6 days ahead', () => {
    expect(syncWindow(new Date('2026-11-17T10:00:00Z'))).toEqual({ dateFrom: '2026-11-14', dateTo: '2026-11-23' });
  });
});
