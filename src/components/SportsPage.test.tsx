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

describe('SportsPage draw pool', () => {
  it('shows home team / Draw / away team buttons and places a draw bet', async () => {
    const drawMatch = { ...match('football', 'Leeds', 'Burnley', 'Championship'), has_draw: true, draw_total: 0, my_draw: 0 };
    mockBackend([drawMatch, match('cricket', 'India', 'England', 'Test Series')]);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    expect(await screen.findByText('Who will win?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Yes/ })).not.toBeInTheDocument();
    const picks = screen.getAllByRole('button', { pressed: false }).map((button) => button.textContent ?? '');
    expect(picks.findIndex((text) => text.startsWith('Leeds'))).toBeLessThan(picks.findIndex((text) => text.startsWith('Draw')));
    expect(picks.findIndex((text) => text.startsWith('Draw'))).toBeLessThan(picks.findIndex((text) => text.startsWith('Burnley')));

    fireEvent.click(screen.getByRole('button', { name: /^Draw/ }));
    expect(screen.getByText('Your pick: Draw')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How much do you want to bet?'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bet ₹100' }));
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledWith('place_sport_bet',
      { p_event_id: drawMatch.id, p_side: 'draw', p_amount: 100 }));
  });

  it('a team button bets on that team, also when the question is about the away side', async () => {
    const drawMatch = { ...match('football', 'Leeds', 'Burnley', 'Championship'), has_draw: true, subject_side: 'away' as const };
    mockBackend([drawMatch]);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Leeds/ }));
    expect(screen.getByText('Your pick: Leeds')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('How much do you want to bet?'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bet ₹50' }));
    // Leeds is the home team and the question is about Burnley, so Leeds is "no".
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledWith('place_sport_bet',
      { p_event_id: drawMatch.id, p_side: 'no', p_amount: 50 }));
  });

  it('keeps Yes/No only on a match without a Draw pool', async () => {
    mockBackend([match('football', 'Ajax', 'PSV', 'Eredivisie')]);
    render(<SportsPage onAddFunds={vi.fn()} onMyBets={vi.fn()} />);
    await screen.findByText('Will Ajax win?');
    expect(screen.queryByRole('button', { name: /^Draw/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yes/ })).toBeInTheDocument();
  });
});
