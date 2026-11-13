import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useNav, type NavView } from '@/lib/useNav';
import { supabase } from '@/lib/supabase';
import type { Game, GameResult } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { friendlyErrorDetails } from '@/lib/errors';
import SelectionScreen from '@/components/SelectionScreen';
import BalancePage from '@/components/BalancePage';
import MyBetsPage from '@/components/MyBetsPage';
import PlayLimitsPage from '@/components/PlayLimitsPage';
import RulesPage from '@/components/RulesPage';
import SettingsPage from '@/components/SettingsPage';
import LegalPage from '@/components/LegalPage';
import GameCard from '@/components/GameCard';
import PlayLimitsSummary from '@/components/PlayLimitsSummary';
import BottomNav, { type TabView } from '@/components/BottomNav';
import Alert from '@/components/ui/Alert';
import { SectionTitle } from '@/components/ui/Card';
import { WITH_BOTTOM_NAV } from '@/components/ui/layout';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import { CardSkeleton } from '@/components/Skeleton';
import { interpolate, useT } from '@/i18n/useT';
import { useFormat } from '@/i18n/useFormat';
import { ChevronRight, Loader2, Plus, User, Wallet, Zap } from 'lucide-react';

const AdminPanel = lazy(() => import('@/components/AdminPanel'));

const TAB_FOR_VIEW: Partial<Record<NavView, TabView>> = {
  home: 'home',
  mybets: 'mybets',
  balance: 'balance',
  wallet: 'balance',
  settings: 'settings',
};

export default function Dashboard() {
  const { user, profile, refreshProfile } = useAuth();
  const { nav, navigate, goHome } = useNav();
  const [adminInitialTab, setAdminInitialTab] = useState<'stats' | 'settings'>('stats');
  const { t } = useT();

  const goTo = (view: NavView, game: Game | null = null) => {
    navigate({ view, game });
    void refreshProfile();
  };
  const backToAccount = () => goTo('settings');

  let page: ReactNode;
  if (nav.view === 'game' && nav.game && user) {
    return (
      <SelectionScreen
        game={nav.game}
        onBack={() => goHome()}
        onPointsChanged={refreshProfile}
        onAddFunds={() => goTo('balance')}
      />
    );
  }
  if (nav.view === 'admin' && user && profile?.is_admin) {
    return (
      <Suspense fallback={
        <div className="flex min-h-screen items-center justify-center bg-surface-page text-ink-muted">
          <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}</div>
        </div>
      }>
        <AdminPanel onBack={() => { setAdminInitialTab('stats'); goTo('settings'); }} initialTab={adminInitialTab} />
      </Suspense>
    );
  }
  if (nav.view === 'limits' && user) return <PlayLimitsPage onBack={backToAccount} />;
  if (nav.view === 'rules') return <RulesPage onBack={backToAccount} />;
  if (nav.view === 'terms' || nav.view === 'privacy' || nav.view === 'contact') {
    return <LegalPage document={nav.view} onBack={backToAccount} />;
  }

  if (nav.view === 'mybets' && user) {
    page = <MyBetsPage onGames={() => goHome()} />;
  } else if ((nav.view === 'balance' || nav.view === 'wallet') && user) {
    page = (
      <BalancePage
        initialTab={nav.view === 'wallet' ? 'withdraw' : 'add'}
        onBalanceChanged={refreshProfile}
        onOpenAdminSettings={profile?.is_admin ? () => { setAdminInitialTab('settings'); goTo('admin'); } : undefined}
      />
    );
  } else if (nav.view === 'settings' && user) {
    page = <SettingsPage onNavigate={(view) => goTo(view)} />;
  } else {
    page = <Home onNavigate={goTo} />;
  }

  const activeTab = TAB_FOR_VIEW[nav.view] ?? 'home';
  return (
    <div className={`min-h-screen bg-surface-page ${WITH_BOTTOM_NAV}`}>
      {page}
      <BottomNav active={activeTab} onNavigate={(view) => (view === 'home' ? goHome() : goTo(view))} />
    </div>
  );
}

function Home({ onNavigate }: { onNavigate: (view: NavView, game?: Game | null) => void }) {
  const { formatNumber } = useFormat();
  const { user, profile } = useAuth();
  const { t } = useT();
  const { statuses: gameStatuses, loading: gameStatusLoading, error: gameStatusError, errorDetails: gameStatusErrorDetails, nowMs, refresh: refreshGameStatus } = useGameStatus();
  const [results, setResults] = useState<Partial<Record<Game, GameResult | null>>>({});
  const [resultsError, setResultsError] = useState<{ message: string; raw?: string } | null>(null);
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const { limits } = useMyLimits();
  const restriction = activePlayRestriction(limits);

  useEffect(() => {
    let active = true;
    if (gameStatuses.length === 0) {
      setResults({});
      setResultsError(null);
      return () => { active = false; };
    }
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('get_all_latest_results');
        if (error) {
          console.error('Failed to load latest results', error);
          const friendly = friendlyErrorDetails(error);
          if (active) setResultsError({ message: friendly.message, raw: friendly.raw });
          return;
        }
        const byGame = Object.fromEntries(
          ((data as GameResult[] | null) ?? []).map((result) => [result.game, result])
        ) as Partial<Record<Game, GameResult | null>>;
        if (active) {
          setResults(byGame);
          setResultsError(null);
        }
      } catch (error) {
        const friendly = friendlyErrorDetails(error);
        if (active) setResultsError({ message: friendly.message, raw: friendly.raw });
      }
    })();
    return () => { active = false; };
  }, [gameStatuses, resultsRefresh]);

  const totalBalance = profile ? (profile.points + profile.wallet) : null;
  const money = (value: number | undefined | null) => (value === undefined || value === null ? '—' : `₹${formatNumber(value)}`);

  return (
    <>
      <header className="sticky top-0 z-20 border-b border-surface-border/80 bg-surface-page/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-gradient-to-br from-brand-400 to-accent-500 shadow-lg shadow-brand-500/20">
              <Zap className="h-4 w-4 text-white" fill="white" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold leading-tight text-ink-strong">BetZone</p>
              <p className="truncate text-xs leading-tight text-ink-muted">{profile?.display_name || user?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('balance')}
              className="tap-target gap-1.5 rounded-control border border-surface-strong bg-surface-raised/80 px-3 hover:border-slate-600"
              aria-label={interpolate(t('dashboard.balanceChip'), { amount: money(totalBalance) })}
            >
              <Wallet className="h-4 w-4 text-brand-400" aria-hidden="true" />
              <span className="text-sm font-bold text-ink-strong">{money(totalBalance)}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              aria-label={t('nav.account')}
              className="tap-target rounded-control border border-surface-strong text-ink-soft hover:bg-surface-raised"
            >
              <User className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-2xl space-y-6 px-4 py-6 sm:px-5">
        {gameStatusError && (
          <Alert details={gameStatusErrorDetails} onRetry={() => void refreshGameStatus()}>
            {t('dashboard.scheduleError')} {gameStatusError}
          </Alert>
        )}
        {resultsError && (
          <Alert details={resultsError.raw} onRetry={() => setResultsRefresh((value) => value + 1)}>
            {t('dashboard.resultsError')} {resultsError.message}
          </Alert>
        )}
        {profile?.is_banned && <Alert>{t('dashboard.banned')}</Alert>}
        {restriction && (
          <Alert tone="warning">
            {interpolate(t(restriction.kind === 'cooldown' ? 'restriction.cooldown' : 'restriction.selfExclusion'), { date: formatLimitEnd(restriction.until) })}
          </Alert>
        )}

        {/* Balance summary: informational, not a call to deposit. */}
        <section className="rounded-card border border-surface-border bg-gradient-to-br from-surface to-surface-raised/60 p-5 animate-slide-up">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{t('dashboard.totalBalance')}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-ink-strong">{money(totalBalance)}</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('balance')}
              className="tap-target gap-1 rounded-control border border-surface-strong px-3 text-sm font-medium text-ink-soft hover:bg-surface-raised"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> {t('dashboard.addFunds')}
            </button>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-surface-border pt-4">
            <div>
              <dt className="text-xs text-ink-muted">{t('dashboard.playBalance')}</dt>
              <dd className="text-lg font-semibold text-accent-400">{money(profile?.points)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">{t('dashboard.withdrawable')}</dt>
              <dd className="text-lg font-semibold text-brand-400">{money(profile?.wallet)}</dd>
            </div>
          </dl>
        </section>

        <PlayLimitsSummary limits={limits} onOpen={() => onNavigate('limits')} />

        <section aria-labelledby="games-title" className="animate-slide-up">
          <SectionTitle id="games-title">{t('dashboard.games')}</SectionTitle>
          <div className="space-y-4">
            {gameStatusLoading ? <><CardSkeleton /><CardSkeleton /></> : gameStatuses.map((status) => (
              <GameCard
                key={status.game}
                status={status}
                result={results[status.game]}
                nowMs={nowMs}
                disabled={profile?.is_banned}
                onOpen={() => onNavigate('game', status.game)}
              />
            ))}
          </div>
        </section>

        <button
          type="button"
          onClick={() => onNavigate('rules')}
          className="flex w-full items-center justify-between rounded-card border border-surface-border px-4 py-3 text-sm text-ink-soft hover:bg-surface/60"
        >
          {t('dashboard.rules')}
          <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden="true" />
        </button>
      </main>
    </>
  );
}
