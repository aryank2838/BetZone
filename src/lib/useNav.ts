import { useEffect, useState, useCallback } from 'react';
import type { Game } from '@/types';

export type NavView = 'home' | 'sports' | 'wallet' | 'admin' | 'balance' | 'game' | 'mybets' | 'limits' | 'rules' | 'settings' | 'terms' | 'privacy' | 'contact';

interface NavState {
  view: NavView;
  game: Game | null;
}

const SESSION_KEY = 'betzone_nav';

function validNavState(value: unknown): value is NavState {
  if (!value || typeof value !== 'object') return false;
  const nav = value as Partial<NavState>;
  const validViews: NavView[] = ['home', 'sports', 'wallet', 'admin', 'balance', 'game', 'mybets', 'limits', 'rules', 'settings', 'terms', 'privacy', 'contact'];
  return validViews.includes(nav.view as NavView)
    // Game ids come from game_schedule; the server rejects unknown ones.
    && (nav.game === null || (typeof nav.game === 'string' && /^[a-z0-9_]{1,40}$/.test(nav.game)))
    && (nav.view !== 'game' || nav.game !== null);
}

/** Screens a notification link (`/?open=…`) can open. */
const OPEN_TARGETS: Record<string, NavView> = { money: 'balance', bets: 'mybets', sports: 'sports' };

export function viewForOpenLink(url: string): NavView | null {
  try {
    const open = new URL(url, 'https://app.invalid').searchParams.get('open');
    return open ? OPEN_TARGETS[open] ?? null : null;
  } catch {
    return null;
  }
}

/** Reads and removes `?open=…` from the address bar (a tapped notification). */
function consumeOpenLink(): NavView | null {
  if (typeof window === 'undefined') return null;
  const view = viewForOpenLink(window.location.href);
  const params = new URLSearchParams(window.location.search);
  if (params.has('open')) {
    params.delete('open');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }
  return view;
}

function readSavedNav(): NavState {
  const linked = consumeOpenLink();
  if (linked) return { view: linked, game: null };
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (validNavState(saved)) return saved;
  } catch { /* ignore */ }
  return { view: 'home', game: null };
}

export function useNav() {
  const [state, setState] = useState<NavState>(readSavedNav);

  useEffect(() => {
    window.history.replaceState({ nav: state }, '');
    const handler = (e: PopStateEvent) => {
      const historyState = e.state as { nav?: unknown } | null;
      const next = historyState?.nav && validNavState(historyState.nav)
        ? historyState.nav
        : { view: 'home', game: null } satisfies NavState;
      setState(next);
      try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [state]);

  const navigate = useCallback((newState: NavState) => {
    setState(newState);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(newState));
    } catch { /* ignore */ }
    window.history.pushState({ nav: newState }, '');
  }, []);

  const goHome = useCallback(() => {
    const homeState: NavState = { view: 'home', game: null };
    setState(homeState);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(homeState));
    } catch { /* ignore */ }
    window.history.pushState({ nav: homeState }, '');
  }, []);

  return { nav: state, navigate, goHome };
}
