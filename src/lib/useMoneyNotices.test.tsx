import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { clearMoneyNotifications, useMoneyNotices } from '@/lib/useMoneyNotices';

const { rpcMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), fromMock: vi.fn() }));

vi.mock('@/lib/supabase', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      rpc: rpcMock,
      from: fromMock,
      channel: () => channel,
      removeChannel: vi.fn(),
    },
  };
});
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1' }, refreshProfile: vi.fn() }),
}));

const deposit = { id: 'd-1', amount: 500, status: 'approved', reject_reason: null, processed_at: '2026-11-26T10:00:00.123456+00:00' };

/** A Supabase query that resolves to `result` whatever filters are chained on it. */
function query(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'gt', 'order', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

function mockTables(seenAt: string) {
  fromMock.mockImplementation((table: string) => {
    if (table === 'profiles') return query({ data: { money_notices_seen_at: seenAt }, error: null });
    if (table === 'add_funds_requests') return query({ data: [deposit], error: null });
    return query({ data: [], error: null });
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('money notices', () => {
  it('stays dismissed on this phone even when saving "Got it" to the server fails', async () => {
    mockTables('2026-11-26T09:00:00+00:00');
    rpcMock.mockResolvedValue({ data: null, error: new Error('network down') });
    const { result, unmount } = renderHook(() => useMoneyNotices());
    await waitFor(() => expect(result.current.notices).toHaveLength(1));

    await act(async () => { await result.current.dismiss(); });
    expect(result.current.notices).toHaveLength(0);
    unmount();

    // Next app open: the server still has the old "seen" time, but the card does not come back,
    // and the dismissal is sent to the server again.
    const reopened = renderHook(() => useMoneyNotices());
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('mark_money_notices_seen', { p_until: deposit.processed_at }));
    expect(reopened.result.current.notices).toHaveLength(0);
  });

  it('still shows a notice that is newer than the dismissal', async () => {
    localStorage.setItem('betzone_notices_dismissed_user-1', '2026-11-26T08:00:00+00:00');
    mockTables('2026-11-26T07:00:00+00:00');
    rpcMock.mockResolvedValue({ data: null, error: null });
    const { result } = renderHook(() => useMoneyNotices());
    await waitFor(() => expect(result.current.notices).toHaveLength(1));
  });
});

describe('clearing the notification tray', () => {
  it('closes only money notifications', async () => {
    const money = { tag: 'deposit_approved', close: vi.fn() };
    const match = { tag: 'match_starting:India vs Australia', close: vi.fn() };
    const registration = { getNotifications: vi.fn().mockResolvedValue([money, match]) };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(registration) },
    });

    await clearMoneyNotifications();
    expect(money.close).toHaveBeenCalled();
    expect(match.close).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });
});
