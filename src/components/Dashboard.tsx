import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useNav, type NavView } from '@/lib/useNav';
import { supabase } from '@/lib/supabase';
import { GAME_LABELS, type Game, type GameResult } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { friendlyErrorDetails } from '@/lib/errors';
import SelectionScreen from '@/components/SelectionScreen';
import WalletPage from '@/components/WalletPage';
import BalancePage from '@/components/BalancePage';
import MyBetsPage from '@/components/MyBetsPage';
import PastResults from '@/components/PastResults';
import PlayLimitsPage from '@/components/PlayLimitsPage';
import RulesPage from '@/components/RulesPage';
import SettingsPage from '@/components/SettingsPage';
import LegalPage from '@/components/LegalPage';
import HelpButton from '@/components/HelpButton';
import { useMyLimits, activePlayRestriction, formatLimitEnd } from '@/lib/useMyLimits';
import { countdownTone, formatBetWindow } from '@/lib/countdown';
import { CardSkeleton } from '@/components/Skeleton';
import CountdownAnnouncement from '@/components/CountdownAnnouncement';
import { interpolate, useT } from '@/i18n/useT';
import { useFormat } from '@/i18n/useFormat';
import { LogOut, Zap, Wallet, Shield, ChevronRight, Trophy, TrendingUp, Clock, Loader2, ReceiptText } from 'lucide-react';

const AdminPanel = lazy(() => import('@/components/AdminPanel'));

export default function Dashboard() {
  const { formatNumber } = useFormat();
  const { user, profile, signOut, refreshProfile } = useAuth();
  const { nav, navigate, goHome } = useNav();
  const { statuses: gameStatuses, loading: gameStatusLoading, error: gameStatusError, errorDetails: gameStatusErrorDetails, nowMs, refresh: refreshGameStatus } = useGameStatus();
  const { t, language } = useT();
  const [results, setResults] = useState<Partial<Record<Game, GameResult | null>>>({});
  const [resultsError, setResultsError] = useState<{ message: string; raw?: string } | null>(null);
  const [resultsRefresh, setResultsRefresh] = useState(0);
  const [adminInitialTab, setAdminInitialTab] = useState<'stats' | 'settings'>('stats');
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

  const goTo = (view: NavView, game: Game | null = null) => {
    navigate({ view, game });
    refreshProfile();
  };

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

  if (nav.view === 'mybets' && user) {
    return <MyBetsPage onBack={() => goHome()} onGames={() => goHome()} />;
  }
  if (nav.view === 'limits' && user) return <PlayLimitsPage onBack={() => goHome()} />;
  if (nav.view === 'rules') return <RulesPage onBack={() => goHome()} />;
  if (nav.view === 'settings' && user) return <SettingsPage onBack={() => goHome()} onPlayLimits={() => goTo('limits')} />;
  if (nav.view === 'terms' || nav.view === 'privacy' || nav.view === 'contact') {
    return <LegalPage document={nav.view} onBack={() => goHome()} />;
  }

  if (nav.view === 'balance' && user) {
    return <BalancePage onBack={() => goHome()} onBalanceChanged={refreshProfile} onMyBets={() => goTo('mybets')} onOpenAdminSettings={profile?.is_admin ? () => { setAdminInitialTab('settings'); goTo('admin'); } : undefined} />;
  }

  if (nav.view === 'wallet' && user) {
    return <WalletPage onBack={() => goHome()} onWalletChanged={refreshProfile} onMyBets={() => goTo('mybets')} />;
  }

  if (nav.view === 'admin' && user && profile?.is_admin) {
    return (
      <Suspense fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-400">
          <div className="flex items-center gap-2 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading admin panel</div>
        </div>
      }>
        <AdminPanel onBack={() => { setAdminInitialTab('stats'); goHome(); }} initialTab={adminInitialTab} />
      </Suspense>
    );
  }

  const totalBalance = profile ? (profile.points + profile.wallet) : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Background glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-emerald-500/10 rounded-full blur-[140px] pointer-events-none" />

      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-2xl mx-auto px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap className="w-4 h-4 text-white" fill="white" />
            </div>
            <div>
              <p className="font-bold text-white text-sm leading-tight">BetZone</p>
              <p className="text-[11px] text-slate-400 leading-tight">{profile?.display_name || user?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo('balance')}
              className="tap-target flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800/80 border border-slate-700 hover:border-slate-600 transition-all"
              aria-label={t('dashboard.viewBalance')}
            >
              <Wallet className="w-4 h-4 text-emerald-400" />
              <span className="text-sm font-bold text-white">{totalBalance === null ? '—' : formatNumber(totalBalance)}</span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            </button>
            <button
              onClick={signOut}
              className="tap-target text-slate-400 hover:text-rose-400 transition-colors p-1.5"
              aria-label={t('common.logout')}
            >
              <LogOut className="w-4 h-4" />
            </button>
            <HelpButton />
            <button type="button" onClick={() => goTo('settings')} className="rounded-lg border border-slate-700 px-2.5 py-2 text-xs text-slate-300 hover:bg-slate-800">{t('dashboard.settings')}</button>
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-5 py-8 space-y-8 relative z-10">
        {gameStatusError && (
          <div role="alert" className="text-sm text-rose-300 bg-rose-950/30 border border-rose-900 rounded-xl px-4 py-3">
            <p>Game schedule could not be refreshed: {gameStatusError}</p>
            {gameStatusErrorDetails && <p className="mt-1 text-xs text-rose-400/70">{gameStatusErrorDetails}</p>}
            <button type="button" onClick={() => void refreshGameStatus()} className="mt-2 text-xs font-semibold text-rose-200">{t('common.retry')}</button>
          </div>
        )}
        {resultsError && (
          <div role="alert" className="rounded-xl border border-rose-900 bg-rose-950/30 px-4 py-3 text-sm text-rose-300">
            <p>Latest results could not be loaded: {resultsError.message}</p>
            {resultsError.raw && <p className="mt-1 text-xs text-rose-400/70">{resultsError.raw}</p>}
            <button type="button" onClick={() => setResultsRefresh((value) => value + 1)} className="mt-2 text-xs font-semibold text-rose-200">{t('common.retry')}</button>
          </div>
        )}
        {profile?.is_banned && (
          <div className="flex items-center gap-2.5 border border-rose-900 bg-rose-950/40 rounded-2xl p-4">
            <Shield className="w-4 h-4 text-rose-400 shrink-0" />
            <p className="text-sm text-rose-300">{t('dashboard.banned')}</p>
          </div>
        )}
        {restriction && (
          <div className="rounded-xl border border-amber-800 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            {restriction.kind === 'cooldown' ? 'Betting break active' : 'Self-exclusion active'} until {formatLimitEnd(restriction.until)}. Withdrawals remain available.
          </div>
        )}
        {/* Balance hero card */}
        <button
          onClick={() => goTo('balance')}
          className="w-full text-left p-6 rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700/50 hover:border-slate-600 transition-all relative overflow-hidden group animate-slide-up"
        >
          <div className="absolute top-0 right-0 opacity-5 group-hover:opacity-10 transition-opacity">
            <Wallet className="w-40 h-40 -mr-10 -mt-10" />
          </div>
          <div className="relative">
            <p className="text-xs font-medium uppercase tracking-widest text-slate-400 mb-1">{t('dashboard.totalBalance')}</p>
            <div className="flex items-baseline gap-2">
              <p className="text-4xl font-bold text-white tracking-tight">{totalBalance === null ? '—' : formatNumber(totalBalance)}</p>
              <p className="text-slate-400 text-sm">{t('dashboard.balanceUnit')}</p>
            </div>
            <div className="flex gap-6 mt-4">
              <div>
                <p className="text-[11px] text-slate-400">{t('dashboard.playBalance')}</p>
                <p className="text-lg font-semibold text-cyan-400">{profile?.points === undefined ? '—' : formatNumber(profile.points)}</p>
              </div>
              <div className="border-l border-slate-700 pl-6">
                <p className="text-[11px] text-slate-400">{t('dashboard.withdrawable')}</p>
                <p className="text-lg font-semibold text-emerald-400">{profile?.wallet === undefined ? '—' : formatNumber(profile.wallet)}</p>
              </div>
            </div>
          </div>
        </button>

        {/* Quick actions */}
        <div className="grid grid-cols-1 gap-3 animate-slide-up sm:grid-cols-3" style={{ animationDelay: '50ms' }}>
          <button
            onClick={() => goTo('balance')}
            className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-semibold hover:from-emerald-400 hover:to-emerald-500 transition-all shadow-lg shadow-emerald-500/15"
          >
            <Wallet className="w-4 h-4" /> {t('dashboard.addFunds')}
          </button>
          <button
            onClick={() => goTo('wallet')}
            className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold hover:bg-slate-700 hover:border-slate-600 transition-all"
          >
            <Trophy className="w-4 h-4 text-amber-400" /> {t('dashboard.wallet')}
          </button>
          <button
            onClick={() => goTo('mybets')}
            className="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-sm font-semibold hover:bg-slate-700 hover:border-slate-600 transition-all"
          >
            <ReceiptText className="w-4 h-4 text-cyan-400" /> {t('dashboard.myBets')}
          </button>
        </div>

        {/* Latest results */}
        {gameStatusLoading ? <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div> : gameStatuses.map((status, idx) => {
          const g = status.game;
          const r = results[g];
          if (!r || (!r.open_digit && !r.close_digit && !r.open_patti && !r.close_patti)) return null;
          const jodi = r.open_digit && r.close_digit ? r.open_digit + r.close_digit : null;
          const hasResult = r.open_digit || r.close_digit;
          return (
            <div key={g} className="rounded-2xl bg-gradient-to-br from-slate-900 to-slate-900 border border-slate-700/50 p-5 animate-slide-up" style={{ animationDelay: `${150 + idx * 50}ms` }}>
              <div className="flex items-center gap-1.5 mb-3">
                <Trophy className="w-3.5 h-3.5 text-amber-400" />
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  {status.label || GAME_LABELS[g]} · {r.round_date === status.server_ist_date ? t('dashboard.todaysResult') : interpolate(t('dashboard.latestResult'), { date: r.round_date })}
                </p>
              </div>
              {hasResult ? (
                <div className="flex items-center justify-center py-3">
                  <div className="flex items-center gap-2 sm:gap-3">
                    {r.open_patti && (
                      <span className="text-2xl font-bold text-slate-400 tabular-nums">{r.open_patti}</span>
                    )}
                    {r.open_patti && jodi && <span className="text-slate-400 text-xl">-</span>}
                    {jodi ? (
                      <span className="text-4xl font-extrabold text-white tabular-nums tracking-tight">
                        <span className="text-emerald-400">{r.open_digit}</span>
                        <span className="text-cyan-400">{r.close_digit}</span>
                      </span>
                    ) : (
                      <>
                        {r.open_digit && <span className="text-4xl font-extrabold text-emerald-400 tabular-nums">{r.open_digit}</span>}
                        {r.close_digit && <span className="text-4xl font-extrabold text-cyan-400 tabular-nums">{r.close_digit}</span>}
                      </>
                    )}
                    {r.close_patti && jodi && <span className="text-slate-400 text-xl">-</span>}
                    {r.close_patti && (
                      <span className="text-2xl font-bold text-slate-400 tabular-nums">{r.close_patti}</span>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400 text-center py-3">{t('dashboard.resultsPending')}</p>
              )}
              {hasResult && (
                <div className="flex justify-center gap-3 mt-1">
                  {r.open_digit && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${r.open_processed ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'}`}>
                      Open {r.open_processed ? 'paid' : 'pending'}
                    </span>
                  )}
                  {r.close_digit && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${r.close_processed ? 'bg-emerald-950 text-emerald-400' : 'bg-amber-950 text-amber-400'}`}>
                      Close {r.close_processed ? 'paid' : 'pending'}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Games */}
        <section className="animate-slide-up" style={{ animationDelay: '200ms' }}>
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">{t('dashboard.games')}</p>
          <div className="space-y-3">
            {gameStatusLoading ? <><CardSkeleton /><CardSkeleton /></> : gameStatuses.map((status, idx) => (
              <div key={status.game}>
                <button
                  type="button"
                  onClick={() => goTo('game', status.game)}
                  disabled={profile?.is_banned}
                  className={`w-full text-left p-5 rounded-2xl border transition-all flex items-center justify-between group hover:scale-[1.01] ${
                    idx === 0
                      ? 'bg-gradient-to-r from-emerald-950/80 to-slate-900 border-emerald-900/50 hover:border-emerald-700'
                      : 'bg-gradient-to-r from-cyan-950/80 to-slate-900 border-cyan-900/50 hover:border-cyan-700'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${idx === 0 ? 'bg-emerald-500/15' : 'bg-cyan-500/15'}`}>
                      <TrendingUp className={`w-5 h-5 ${idx === 0 ? 'text-emerald-400' : 'text-cyan-400'}`} />
                    </div>
                    <div>
                      <p className="font-bold text-white text-base">{status.label || GAME_LABELS[status.game]}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {([
                          ['Open', status.open_bets_open, status.open_bets_close_ts],
                          ['Close', status.close_bets_open, status.close_bets_close_ts],
                        ] as const).map(([label, schedule, cutoff]) => {
                          const tone = schedule ? countdownTone(cutoff, nowMs) : 'closed';
                          return (
                            <span key={label} className={`flex items-center gap-1 text-[11px] ${
                              tone === 'red' || tone === 'closed' ? 'text-rose-400' : tone === 'amber' ? 'text-amber-400' : 'text-slate-400'
                            }`}>
                              <Clock className="h-3 w-3" />
                              {label} · {formatBetWindow(schedule, cutoff, status.bets_open_at, nowMs, language)}
                              <CountdownAnnouncement
                                cutoff={cutoff}
                                opensAt={status.bets_open_at}
                                isOpen={schedule}
                                nowMs={nowMs}
                                label={`${label} bets`}
                              />
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-700 group-hover:text-slate-500 transition-colors" />
                </button>
                <PastResults game={status.game} />
              </div>
            ))}
          </div>
        </section>

        {/* Admin link */}
        {profile?.is_admin && (
          <section className="animate-slide-up" style={{ animationDelay: '250ms' }}>
            <button
              onClick={() => goTo('admin')}
              className="w-full text-left p-4 rounded-2xl border border-slate-800 bg-slate-900/80 hover:border-slate-700 hover:bg-slate-800/80 transition-all flex items-center justify-between group"
            >
              <div className="flex items-center gap-2.5">
                <Shield className="w-4 h-4 text-amber-400" />
                <p className="font-medium text-white">{t('dashboard.adminPanel')}</p>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-700 group-hover:text-slate-500 transition-colors" />
            </button>
          </section>
        )}
        <section className="grid grid-cols-2 gap-2 text-xs text-slate-400">
          <button type="button" onClick={() => goTo('limits')} className="min-h-[44px] rounded-lg border border-slate-800 py-2 hover:text-slate-300">{t('dashboard.playLimits')}</button>
          <button type="button" onClick={() => goTo('rules')} className="min-h-[44px] rounded-lg border border-slate-800 py-2 hover:text-slate-300">{t('dashboard.rules')}</button>
          <button type="button" onClick={() => goTo('terms')} className="min-h-[44px] rounded-lg border border-slate-800 py-2 hover:text-slate-300">{t('dashboard.terms')}</button>
          <button type="button" onClick={() => goTo('privacy')} className="min-h-[44px] rounded-lg border border-slate-800 py-2 hover:text-slate-300">{t('dashboard.privacy')}</button>
          <button type="button" onClick={() => goTo('contact')} className="min-h-[44px] rounded-lg border border-slate-800 py-2 hover:text-slate-300">{t('dashboard.contact')}</button>
        </section>
      </main>
    </div>
  );
}
