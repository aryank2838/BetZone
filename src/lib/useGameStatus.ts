import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { GameStatus } from '@/types';
import { friendlyError, rawErrorMessage } from '@/lib/errors';
import { correctedClockNow, serverClockOffset } from '@/lib/countdown';

export function useGameStatus() {
  const [statuses, setStatuses] = useState<GameStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState('');
  const [offsetMs, setOffsetMs] = useState(0);
  const [clockNowMs, setClockNowMs] = useState(Date.now);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const { data, error: rpcError } = await supabase.rpc('get_game_status');
      if (currentRequest !== requestId.current) return;
      if (rpcError) {
        const friendly = friendlyError(rpcError);
        setError(friendly.message);
        setErrorDetails(friendly.key === 'errors.generic' ? rawErrorMessage(rpcError) : '');
        setLoading(false);
        return;
      }
      const nextStatuses = (data as GameStatus[] | null) ?? [];
      if (nextStatuses[0]?.server_now) {
        setOffsetMs(serverClockOffset(nextStatuses[0].server_now, Date.now()));
      }
      setStatuses(nextStatuses);
      setError(null);
      setErrorDetails('');
      setLoading(false);
    } catch (requestError) {
      if (currentRequest !== requestId.current) return;
      const friendly = friendlyError(requestError);
      setError(friendly.message);
      setErrorDetails(friendly.key === 'errors.generic' ? rawErrorMessage(requestError) : '');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const clockInterval = window.setInterval(() => setClockNowMs(Date.now()), 1000);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clockInterval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  const nowMs = correctedClockNow(clockNowMs, offsetMs);

  useEffect(() => {
    const cutoffs = statuses.flatMap((status) => [
      Date.parse(status.open_bets_close_ts),
      Date.parse(status.close_bets_close_ts),
    ]).filter((cutoff) => Number.isFinite(cutoff));
    if (cutoffs.length === 0) return;
    const nextCutoff = Math.min(...cutoffs);
    const delay = Math.max(0, nextCutoff - (Date.now() + offsetMs));
    const timer = window.setTimeout(() => { void refresh(); }, delay);
    return () => window.clearTimeout(timer);
  }, [statuses, offsetMs, refresh]);

  return { statuses, loading, error, errorDetails, refresh, offsetMs, nowMs };
}
