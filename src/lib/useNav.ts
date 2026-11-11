import { useEffect, useState, useCallback } from 'react';
import type { Game } from '@/types';

export type NavView = 'home' | 'wallet' | 'admin' | 'balance' | 'game' | 'mybets' | 'limits' | 'rules' | 'settings' | 'terms' | 'privacy' | 'contact';

interface NavState {
  view: NavView;
  game: Game | null;
}

const SESSION_KEY = 'betzone_nav';

function validNavState(value: unknown): value is NavState {
  if (!value || typeof value !== 'object') return false;
  const nav = value as Partial<NavState>;
  const validViews: NavView[] = ['home', 'wallet', 'admin', 'balance', 'game', 'mybets', 'limits', 'rules', 'settings', 'terms', 'privacy', 'contact'];
  return validViews.includes(nav.view as NavView)
    // Game ids come from game_schedule; the server rejects unknown ones.
    && (nav.game === null || (typeof nav.game === 'string' && /^[a-z0-9_]{1,40}$/.test(nav.game)))
    && (nav.view !== 'game' || nav.game !== null);
}

function readSavedNav(): NavState {
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
