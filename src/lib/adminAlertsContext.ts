import { createContext, useContext } from 'react';
import type { NotificationState } from '@/lib/adminAlerts';
import type { PushState } from '@/lib/push';

export interface PendingStats {
  pending_withdrawals_count: number;
  pending_withdrawals_amount: number;
  pending_addfunds_count: number;
  pending_addfunds_amount: number;
}

export interface AdminAlertsValue {
  stats: PendingStats | null;
  failed: boolean;
  /** Pending add-money + withdrawal requests. */
  waiting: number;
  /** Goes up on every live request change; the Requests tab reloads when it changes. */
  version: number;
  /** Whether the live connection is up (false means we fall back to polling). */
  live: boolean;
  notifications: NotificationState;
  enableNotifications: () => Promise<void>;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  refresh: () => Promise<void>;
  /** Web Push on this device: alerts arrive even when BetZone is closed. */
  push: PushState;
  pushBusy: boolean;
  /** Turns phone alerts on (must run from a tap). Resolves to the new state. */
  enablePush: () => Promise<PushState>;
  disablePush: () => Promise<void>;
  /** Queues a test notification to this admin's devices. */
  sendTestPush: () => Promise<void>;
}

export const AdminAlertsContext = createContext<AdminAlertsValue | null>(null);

/** Live admin alert state; null outside AdminAlertsProvider, i.e. for players. */
export function useAdminAlerts() {
  return useContext(AdminAlertsContext);
}

/** Today's date in India (YYYY-MM-DD), which the admin report RPCs expect. */
export function istToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}
