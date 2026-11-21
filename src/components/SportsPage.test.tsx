import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import SportsPage from '@/components/SportsPage';
import type { SportEvent } from '@/lib/sportsPool';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ refreshProfile: vi.fn() }) }));

let nextId = 0;
function match(sport: SportEvent['sport'], home: string, away: string, competition: string): SportEvent {
  nextId += 1;
  return {
    id: `m${nextId}`, sport, competition: competition.slice(0, 3).toUpperCase(), competition_name: competition,
    home_team: home, away_team: away, subject_side: 'home',
    starts_at: new Date(Date.now() + (nextId + 1) * 60 * 60 * 1000).toISOString(),
    state: 'open', provider_status: 'scheduled', home_score: null, away_score: null, outcome: null, void_reason: null,
    fee_percent: 10, yes_total: 0, no_total: 0, house_yes: 0, house_no: 0, house_seeded: false, my_yes: 0, my_no: 0,
  };
}

function mockBackend(events: SportEvent[]) {
  rpcMock.mockImplementation((name: string) => {
    if (name === 'get_sport_events') {
      return Promise.resolve({
        data: { football_enabled: true, cricket_enabled: true, min_bet: 10, max_bet: 5000, house_seed: 0, events },
        error: null,
      });
    }
    return Promise.resolve({ data: [], error: null });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const EVENTS = [
  match('football', 'Arsenal', 'Chelsea', 'Premier League'),
  match('football', 'Liverpool', 'Everton', 'Premier League'),
  match('football', 'Atlético Madrid', 'Sevilla', 'La Liga'),
  match('cricket', 'India', 'Australia', 'ODI Series'),
];

describe('SportsPage search', () => {
  it('filters matches by team name as the player types, and clears', async () => {
    mockBackend(EVENTS);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    const search = await screen.findByRole('searchbox', { name: 'Search matches' });
    expect(screen.getByText('Will Liverpool win?')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'atletico' } });
    expect(screen.getByText('Will Atlético Madrid win?')).toBeInTheDocument();
    expect(screen.queryByText('Will Liverpool win?')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 matches')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByText('Will Liverpool win?')).toBeInTheDocument();
  });

  it('filters by league chip', async () => {
    mockBackend(EVENTS);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /La Liga/ }));
    expect(screen.getByText('Will Atlético Madrid win?')).toBeInTheDocument();
    expect(screen.queryByText('Will Arsenal win?')).not.toBeInTheDocument();
  });

  it('points to the other sport when the match is there', async () => {
    mockBackend(EVENTS);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'india' } });
    expect(screen.getByText('No matches for “india”')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '1 found in Cricket' }));
    expect(screen.getByText('Will India win?')).toBeInTheDocument();
  });
});
