import { describe, expect, it } from 'vitest';
import {
  cricketFormat, cricketResult, cricketStartMs, isSeriesInWindow, leagueSearches, mapCricketMatch, nextCricketCheck, parseSeriesDate, seriesLeague,
  type CricketLeague,
} from './cricketData';

const NZ = { id: '9f0a2527-1508-42b3-9945-4ade13fd4b5a', name: 'India tour of New Zealand 2026' };
const teams: [string, string] = ['New Zealand', 'India'];
const ALL: CricketLeague[] = ['india', 'ipl', 'wbbl', 'bbl', 'wpl'];

describe('seriesLeague', () => {
  it('finds India senior series and each league', () => {
    expect(seriesLeague('India tour of New Zealand 2026', ALL)).toBe('india');
    expect(seriesLeague('Sri Lanka tour of India, 2026', ALL)).toBe('india');
    expect(seriesLeague('India Women tour of South Africa, 2026', ALL)).toBe('india');
    expect(seriesLeague('Indian Premier League 2027', ALL)).toBe('ipl');
    expect(seriesLeague('Womens Big Bash League 2026', ALL)).toBe('wbbl');
    expect(seriesLeague('Big Bash League 2026-27', ALL)).toBe('bbl');
    expect(seriesLeague('Womens Premier League 2027', ALL)).toBe('wpl');
  });
  it('skips A teams, youth cricket, other series and leagues that are off', () => {
    expect(seriesLeague('India A tour of Nepal, 2026', ALL)).toBeNull();
    expect(seriesLeague('England A Women tour of India 2026', ALL)).toBeNull();
    expect(seriesLeague('England Women U19 tour of India 2026', ALL)).toBeNull();
    expect(seriesLeague('Pakistan tour of England', ALL)).toBeNull();
    expect(seriesLeague('Big Bash League 2026-27', ['india', 'ipl', 'wbbl'])).toBeNull();
  });
  it('searches once for WBBL and BBL together', () => {
    expect(leagueSearches(['india', 'wbbl', 'bbl'])).toEqual(['India', 'Big Bash']);
  });
});

describe('series dates', () => {
  it('reads ISO dates and month-day dates relative to the start', () => {
    const start = parseSeriesDate('2026-10-22', null)!;
    expect(new Date(start).toISOString().slice(0, 10)).toBe('2026-10-22');
    expect(new Date(parseSeriesDate('Dec 01', start)!).toISOString().slice(0, 10)).toBe('2026-12-01');
    const decStart = parseSeriesDate('2026-12-20', null)!;
    expect(new Date(parseSeriesDate('Jan 09', decStart)!).toISOString().slice(0, 10)).toBe('2027-01-09');
  });
  it('isSeriesInWindow covers 3 days back to 8 days ahead', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    expect(isSeriesInWindow({ id: 'a', name: NZ.name, startDate: '2026-10-22', endDate: 'Dec 01' }, now)).toBe(true);
    expect(isSeriesInWindow({ id: 'b', name: 'x', startDate: '2026-12-13', endDate: 'Dec 27' }, now)).toBe(false);
    expect(isSeriesInWindow({ id: 'c', name: 'x', startDate: '2026-08-07', endDate: 'Aug 27' }, now)).toBe(false);
  });
});

describe('cricketStartMs', () => {
  it('uses the earlier of dateTimeGMT and the status start time', () => {
    const ms = cricketStartMs({ id: 'x', dateTimeGMT: '2026-11-19T22:00:00', status: 'Match starts at Nov 18, 22:00 GMT' });
    expect(new Date(ms!).toISOString()).toBe('2026-11-18T22:00:00.000Z');
  });
  it('treats dateTimeGMT as GMT and handles a year change', () => {
    expect(new Date(cricketStartMs({ id: 'x', dateTimeGMT: '2026-11-27T22:00:00', status: '' })!).toISOString())
      .toBe('2026-11-27T22:00:00.000Z');
    expect(new Date(cricketStartMs({ id: 'x', dateTimeGMT: '2027-01-01T03:30:00', status: 'Match starts at Dec 31, 03:30 GMT' })!).toISOString())
      .toBe('2026-12-31T03:30:00.000Z');
  });
});

describe('cricketResult', () => {
  it('reads wins, including DLS and extra notes', () => {
    expect(cricketResult('India won by 22 runs', teams)).toBe('away');
    expect(cricketResult('New Zealand won by 244 runs', teams)).toBe('home');
    expect(cricketResult('India won by 4 runs (DLS method)', teams)).toBe('away');
    expect(cricketResult('India won by 5 wkts  -  2nd inns reduced to 32 overs - DLS Target 143', teams)).toBe('away');
  });
  it('handles ties, super overs, draws and no result', () => {
    expect(cricketResult('Match tied', teams)).toBe('draw');
    expect(cricketResult('Match tied (India won the Super Over)', teams)).toBe('away');
    expect(cricketResult('Match drawn', teams)).toBe('draw');
    expect(cricketResult('Match abandoned due to rain (with toss)', teams)).toBe('cancelled');
    expect(cricketResult('No result', teams)).toBe('cancelled');
  });
  it('returns null for text it does not understand or an unknown winner', () => {
    expect(cricketResult('Day 2: 3rd Session - South Africa trail by 224 runs', teams)).toBeNull();
    expect(cricketResult('Australia won by 3 wkts', teams)).toBeNull();
  });
});

describe('mapCricketMatch', () => {
  it('maps an upcoming India away match with India as the question', () => {
    const event = mapCricketMatch({
      id: '163a0512', status: 'Match starts at Nov 18, 22:00 GMT', dateTimeGMT: '2026-11-19T22:00:00',
      teams: ['New Zealand', 'India'], matchStarted: false, matchEnded: false,
    }, NZ);
    expect(event).toMatchObject({
      provider: 'cricketdata', sport: 'cricket', competition: NZ.id, competition_name: NZ.name,
      home_team: 'New Zealand', away_team: 'India', subject_side: 'away',
      starts_at: '2026-11-18T22:00:00.000Z', status: 'scheduled', winner: null,
    });
  });
  it('maps finished, live and abandoned matches', () => {
    const base = { id: 'm', dateTimeGMT: '2026-11-15T02:00:00', teams: ['New Zealand', 'India'] };
    expect(mapCricketMatch({ ...base, status: 'India won by 22 runs', matchStarted: true, matchEnded: true }, NZ))
      .toMatchObject({ status: 'finished', winner: 'away' });
    expect(mapCricketMatch({ ...base, status: 'India opt to bat', matchStarted: true, matchEnded: false }, NZ))
      .toMatchObject({ status: 'live', winner: null });
    expect(mapCricketMatch({ ...base, status: 'Match abandoned due to rain', matchStarted: true, matchEnded: true }, NZ))
      .toMatchObject({ status: 'cancelled' });
    expect(mapCricketMatch({ ...base, status: 'Something odd', matchStarted: true, matchEnded: true }, NZ))
      .toMatchObject({ status: 'finished', winner: null });
  });
  it('skips matches without India (outside the IPL) and undecided teams', () => {
    expect(mapCricketMatch({ id: 'x', dateTimeGMT: '2026-11-20T02:00:00', teams: ['Australia', 'England'] }, NZ)).toBeNull();
    expect(mapCricketMatch({ id: 'x', dateTimeGMT: '2027-01-08T03:30:00', teams: ['Tbc', 'Tbc'] }, NZ)).toBeNull();
    expect(mapCricketMatch({ id: 'x', dateTimeGMT: '2027-04-01T14:00:00', teams: ['Mumbai Indians', 'Chennai Super Kings'] },
      { id: 'ipl', name: 'Indian Premier League 2027' })).toMatchObject({ subject_side: 'home', home_team: 'Mumbai Indians' });
    expect(mapCricketMatch({ id: 'w', dateTimeGMT: '2026-11-20T08:10:00', teams: ['Sydney Sixers Women', 'Perth Scorchers Women'] },
      { id: 'wbbl', name: 'Womens Big Bash League 2026' })).toMatchObject({ subject_side: 'home', home_team: 'Sydney Sixers Women' });
  });
});

describe('cricketFormat', () => {
  it('uses matchType, then the match name', () => {
    expect(cricketFormat({ matchType: 'odi' })).toBe('odi');
    expect(cricketFormat({ name: 'New Zealand vs India, 2nd Test, India tour of New Zealand 2026' })).toBe('test');
    expect(cricketFormat({ name: 'New Zealand vs India, 3rd ODI' })).toBe('odi');
    expect(cricketFormat({ name: 'Sixers vs Scorchers, 12th Match' })).toBe('t20');
  });
});

describe('nextCricketCheck', () => {
  const MIN = 60_000;
  const HR = 60 * MIN;
  const now = Date.parse('2026-11-20T10:00:00Z');
  const wbbl = { id: 'wbbl', name: 'Womens Big Bash League 2026' };
  const teams = ['Sydney Sixers Women', 'Perth Scorchers Women'];
  const gmt = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const match = (id: string, startMs: number, extra: Record<string, unknown> = {}) => ({
    id, teams, dateTimeGMT: gmt(startMs), status: '', matchStarted: false, matchEnded: false, ...extra,
  });

  it('checks every 6 hours when nothing is close', () => {
    expect(nextCricketCheck([match('a', now + 3 * 24 * HR)], wbbl, now, new Set())).toBe(now + 6 * HR);
  });
  it('checks 2 hours before the start, then hourly', () => {
    expect(nextCricketCheck([match('a', now + 5 * HR)], wbbl, now, new Set())).toBe(now + 3 * HR);
    expect(nextCricketCheck([match('a', now + 30 * MIN)], wbbl, now, new Set())).toBe(now + HR);
  });
  it('waits until a T20 could be finishing, then checks every 15 minutes', () => {
    const live = { matchStarted: true, status: 'Perth Scorchers Women opt to bowl' };
    expect(nextCricketCheck([match('a', now - HR, live)], wbbl, now, new Set(['a']))).toBe(now + 1.75 * HR);
    expect(nextCricketCheck([match('a', now - 3 * HR, live)], wbbl, now, new Set(['a']))).toBe(now + 15 * MIN);
  });
  it('checks a Test every 30 minutes from day 3', () => {
    const nz = { id: 'nz', name: 'India tour of New Zealand 2026' };
    const test = (start: number) => ({
      id: 't', teams: ['New Zealand', 'India'], name: 'New Zealand vs India, 2nd Test', dateTimeGMT: gmt(start),
      status: 'Day 2: Stumps', matchStarted: true, matchEnded: false,
    });
    expect(nextCricketCheck([test(now - 24 * HR)], nz, now, new Set(['t']))).toBe(now + 2 * HR);
    expect(nextCricketCheck([test(now - 3.5 * 24 * HR)], nz, now, new Set(['t']))).toBe(now + 30 * MIN);
  });
  it('rechecks a finished match 15 minutes later until it is paid', () => {
    const done = match('a', now - 4 * HR, { matchStarted: true, matchEnded: true, status: 'Sydney Sixers Women won by 5 wkts' });
    expect(nextCricketCheck([done], wbbl, now, new Set(['a']))).toBe(now + 15 * MIN);
    expect(nextCricketCheck([done], wbbl, now, new Set())).toBe(now + 6 * HR);
  });
  it('ignores matches we do not offer', () => {
    const other = { id: 'x', teams: ['Australia', 'England'], dateTimeGMT: gmt(now + 30 * MIN), matchStarted: false };
    expect(nextCricketCheck([other], { id: 'nz', name: 'India tour of New Zealand 2026' }, now, new Set())).toBe(now + 6 * HR);
  });
});
