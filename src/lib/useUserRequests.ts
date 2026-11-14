import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyErrorDetails } from '@/lib/errors';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { useVisibleInterval } from '@/lib/useVisibleInterval';

export interface UserRequest {
  id: string;
  kind: 'deposit' | 'withdrawal';
  amount: number;
  status: string;
  created_at: string;
  processed_at: string | null;
  reject_reason: string | null;
}

export function useUserRequests() {
  const { refreshProfile } = useAuth();
  const [requests, setRequests] = useState<UserRequest[]>([]);
  const [error, setError] = useState<{ message: string; raw?: string } | null>(null);
  const previousStatuses = useRef<Map<string, string> | null>(null);

  const refresh = useCallback(async () => {
    const [deposits, withdrawals] = await Promise.all([
      supabase.from('add_funds_requests')
        .select('id, amount, status, created_at, processed_at, reject_reason')
        .order('created_at', { ascending: false }).limit(50),
      supabase.from('withdrawals')
        .select('id, amount, status, created_at, processed_at, reject_reason')
        .order('created_at', { ascending: false }).limit(50),
    ]);
    const requestError = deposits.error ?? withdrawals.error;
    if (requestError) {
      const friendly = friendlyErrorDetails(requestError);
      setError({ message: friendly.message, raw: friendly.raw });
      return;
    }

    const next = [
      ...(deposits.data ?? []).map((request) => ({ ...request, kind: 'deposit' as const })),
      ...(withdrawals.data ?? []).map((request) => ({ ...request, kind: 'withdrawal' as const })),
    ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const previous = previousStatuses.current;
    if (previous && next.some((request) =>
      previous.has(`${request.kind}:${request.id}`)
      && previous.get(`${request.kind}:${request.id}`) !== request.status
    )) {
      await refreshProfile();
    }
    previousStatuses.current = new Map(
      next.map((request) => [`${request.kind}:${request.id}`, request.status]),
    );
    setRequests(next);
    setError(null);
  }, [refreshProfile]);

  useEffect(() => { void refresh(); }, [refresh]);

  const hasPending = requests.some((request) => request.status === 'pending');
  useVisibleInterval(() => { void refresh(); }, 20_000, hasPending);

  return { requests, error, refresh };
}
