import { describe, expect, it } from 'vitest';
import {
  cricketResult, cricketStartMs, isSeriesInWindow, isWantedSeries, mapCricketMatch, parseSeriesDate,
} from './cricketData';

const NZ = { id: '9f0a2527-1508-42b3-9945-4ade13fd4b5a', name: 'India tour of New Zealand 2026' };
const teams: [string, string] = ['New Zealand', 'India'];

describe('isWantedSeries', () => {
  it('keeps India senior series and the IPL', () => {
    expect(isWantedSeries('India tour of New Zealand 2026')).toBe(true);
    expect(isWantedSeries('Sri Lanka tour of India, 2026')).toBe(true);
    expect(isWantedSeries('India Women tour of South Africa, 2026')).toBe(true);
    expect(isWantedSeries('Indian Premier League 2027')).toBe(true);
  });
  it('skips A teams and youth cricket', () => {
    expect(isWantedSeries('India A tour of Nepal, 2026')).toBe(false);
    expect(isWantedSeries('England A Women tour of India 2026')).toBe(false);
    expect(isWantedSeries('England Women U19 tour of India 2026')).toBe(false);
    expect(isWantedSeries('Pakistan tour of England')).toBe(false);
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
  });
});
