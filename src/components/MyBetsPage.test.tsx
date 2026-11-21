import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import MyBetsPage from '@/components/MyBetsPage';
import type { MySportBet } from '@/lib/sportsPool';

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { rpc: rpcMock } }));
vi.mock('@/lib/useGameStatus', () => ({ useGameStatus: () => ({ statuses: [] }) }));

const NOW = Date.parse('2026-11-21T10:00:00Z');

function bet(overrides: Partial<MySportBet> & { starts_at?: string; outcome?: 'yes' | 'no' | null }): MySportBet {
  const { starts_at = '2026-11-21T18:00:00Z', outcome = null, ...rest } = overrides;
  return {
    id: Math.random().toString(36).slice(2),
    side: 'yes',
    amount: 100,
    status: 'open',
    payout: 0,
    created_at: '2026-11-20T10:00:00Z',
    event: {
      id: 'e1', sport: 'football', competition_name: 'Premier League',
      home_team: 'Arsenal', away_team: 'Chelsea', subject_side: 'home',
      starts_at, state: 'open', outcome, void_reason: null, home_score: null, away_score: null,
    },
    ...rest,
  };
}

function mockBackend({ gameRounds = [] as unknown[], sportBets = [] as MySportBet[] } = {}) {
  rpcMock.mockImplementation((name: string) => {
    switch (name) {
      case 'get_my_bets':
        return Promise.resolve({ data: gameRounds, error: null });
      case 'get_my_sport_bets':
        return Promise.resolve({ data: sportBets, error: null });
      case 'get_my_sport_bet_totals': {
        const open = sportBets.filter((b) => b.status === 'open');
        const settled = sportBets.filter((b) => b.status === 'won' || b.status === 'lost');
        return Promise.resolve({
          data: {
            bet_count: sportBets.length,
            open_count: open.length,
            open_stake: open.reduce((sum, b) => sum + b.amount, 0),
            won_count: sportBets.filter((b) => b.status === 'won').length,
            settled_stake: settled.reduce((sum, b) => sum + b.amount, 0),
            returned: sportBets.filter((b) => b.status === 'won').reduce((sum, b) => sum + b.payout, 0),
          },
          error: null,
        });
      }
      default:
        return Promise.resolve({ data: null, error: null });
    }
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('MyBetsPage', () => {
  it('opens on Sports for a player who only bet on sports, and shows their bets', async () => {
    mockBackend({
      sportBets: [
        bet({ amount: 200 }),
        bet({ status: 'won', amount: 100, payout: 180, outcome: 'yes', starts_at: '2026-11-19T18:00:00Z' }),
        bet({ status: 'lost', side: 'no', amount: 50, outcome: 'yes', starts_at: '2026-11-18T18:00:00Z' }),
      ],
    });
    render(<MyBetsPage onGames={vi.fn()} onSports={vi.fn()} />);

    expect(await screen.findByText('Waiting for result (1)')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Sports/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByText('Won ₹180')).toBeInTheDocument();
    expect(screen.getByText('+₹80 profit')).toBeInTheDocument();
    expect(screen.getByText('−₹50')).toBeInTheDocument();
    // Net: 180 back on 150 settled.
    expect(screen.getByText('+₹30')).toBeInTheDocument();
    expect(screen.getByText('Starts in 8:00:00')).toBeInTheDocument();
  });

  it('stays on Games when the player has game bets, with the open sports count on the tab', async () => {
    mockBackend({
      gameRounds: [{ game: 'test', round_date: '2026-11-20', bet_types: [], staked: 10, won: 0, pending_stake: 0 }],
      sportBets: [bet({}), bet({})],
    });
    render(<MyBetsPage onGames={vi.fn()} onSports={vi.fn()} />);

    const sportsTab = await screen.findByRole('tab', { name: /Sports\s*2\s*open bets/ });
    expect(screen.getByRole('tab', { name: /Games/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(sportsTab);
    expect(await screen.findByText('Waiting for result (2)')).toBeInTheDocument();
    expect(sessionStorage.getItem('betzone_mybets_tab')).toBe('sports');
  });

  it('offers to browse matches when there are no sports bets', async () => {
    mockBackend();
    sessionStorage.setItem('betzone_mybets_tab', 'sports');
    const onSports = vi.fn();
    render(<MyBetsPage onGames={vi.fn()} onSports={onSports} />);

    fireEvent.click(await screen.findByRole('button', { name: 'See matches' }));
    expect(onSports).toHaveBeenCalled();
  });
});
