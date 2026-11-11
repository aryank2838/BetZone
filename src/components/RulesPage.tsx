import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { BET_TYPES, GAME_LABELS, type BetType } from '@/types';
import { useGameStatus } from '@/lib/useGameStatus';
import { supabase } from '@/lib/supabase';
import { friendlyErrorDetails } from '@/lib/errors';
import HelpButton from '@/components/HelpButton';

interface PublicRulesView {
  minimum_withdrawal: number;
  maximum_withdrawal: number;
  approved_deposit_minimum: number;
  turnover_multiplier: number;
  maximum_bet: number;
  maximum_submit: number;
}

export default function RulesPage({ onBack }: { onBack: () => void }) {
  const { statuses, error, errorDetails } = useGameStatus();
  const [rules, setRules] = useState<PublicRulesView | null>(null);
  const [rulesError, setRulesError] = useState('');
  useEffect(() => {
    void supabase.rpc('get_public_rules').then(({ data, error: rpcError }) => {
      if (rpcError) {
        const friendly = friendlyErrorDetails(rpcError);
        setRulesError(friendly.raw ? `${friendly.message} ${friendly.raw}` : friendly.message);
      } else setRules(data as PublicRulesView);
    });
  }, []);
  return (
    <main className="min-h-screen bg-slate-950 px-5 py-8 text-slate-100">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between"><button type="button" onClick={onBack} className="tap-target flex items-center gap-2 text-sm text-slate-400 hover:text-white"><ArrowLeft className="h-4 w-4" /> Back</button><HelpButton /></div>
        <header><h1 className="text-2xl font-bold">How it works / Rules</h1><p className="mt-1 text-sm text-slate-400">Game rules and schedules use India Standard Time (IST).</p></header>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">Bet types</h2>
          {rules ? <p className="text-xs text-slate-400">Maximum stake per pick: {rules.maximum_bet}; maximum per submit: {rules.maximum_submit} balance.</p> : !rulesError ? <p className="text-xs text-slate-400">Loading bet limits…</p> : null}
          {(Object.keys(BET_TYPES) as BetType[]).map((type) => {
            const info = BET_TYPES[type];
            const example = info.inputType === 'digit' ? '7' : info.inputType === 'jodi' ? '42' : '123-6';
            return <div key={type} className="border-t border-slate-800 pt-3">
              <p className="text-sm font-medium">{info.label} · {info.multiplier}×</p>
              <p className="text-xs text-slate-400">{info.description} Format: {info.placeholder}. Example: {example}; a 10 balance stake has a potential win of {10 * info.multiplier}.</p>
            </div>;
          })}
        </section>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="font-semibold">Game schedules</h2>
          {error && <p className="text-sm text-rose-300">{error}{errorDetails && ` ${errorDetails}`}</p>}
          {statuses.map((status) => <div key={status.game} className="border-t border-slate-800 pt-3 text-sm">
            <p className="font-medium">{status.label || GAME_LABELS[status.game]}</p>
            <p className="text-xs text-slate-400">Opens {status.bets_open_at} IST · open picks close {status.open_bets_close_at} IST · close picks close {status.close_bets_close_at} IST</p>
          </div>)}
        </section>
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900 p-5 text-sm text-slate-300">
          <h2 className="font-semibold text-white">Play and withdrawals</h2>
          {rulesError && <p className="text-xs text-rose-300">{rulesError}</p>}
          <p>Results are posted by the operator. Picks lock after submission and cannot be edited.</p>
          <p>Play balance is used first; remaining stake is taken from the wallet. Winnings are credited to the wallet.</p>
          {rules ? <p>Withdrawals require at least {rules.approved_deposit_minimum} in approved deposits and wagering turnover equal to {rules.turnover_multiplier}× approved deposits. The minimum request is {rules.minimum_withdrawal} and the maximum is {rules.maximum_withdrawal}; only one withdrawal may be pending at a time.</p> : !rulesError ? <p className="text-xs text-slate-400">Loading withdrawal rules…</p> : null}
          <p>To report a disputed result or transaction, use Help → Report a problem and include the relevant request when possible.</p>
        </section>
      </div>
    </main>
  );
}
