import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Profile } from '@/types';
import { friendlyErrorDetails } from '@/lib/errors';
import {
  ACTIVITY_STORAGE_KEY,
  ACTIVITY_THROTTLE_MS,
  INACTIVITY_TIMEOUT_MS,
  INACTIVITY_WARNING_MS,
  clearStoredActivity,
  inactivityRemaining,
  parseActivityTimestamp,
  readStoredActivity,
  writeStoredActivity,
} from '@/lib/inactivity';
import { isStandalone } from '@/lib/installPrompt';

interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileError: string | null;
  profileErrorDetails: string | null;
  passwordRecovery: boolean;
  inactivityWarning: number | null;
}

interface AuthContextValue extends AuthState {
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  clearPasswordRecovery: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null,
    user: null,
    profile: null,
    loading: true,
    profileError: null,
    profileErrorDetails: null,
    passwordRecovery: false,
    inactivityWarning: null,
  });
  const requestId = useRef(0);
  const userId = useRef<string | null>(null);
  // In-memory copy of the last-activity time, used when localStorage is blocked.
  const activityMemory = useRef<number | null>(null);

  const loadProfile = useCallback(async (userId: string): Promise<Profile> => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, points, wallet, is_admin, is_banned, created_at, terms_accepted_at, terms_version, age_confirmed')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Your account profile could not be found.');
    return data as Profile;
  }, []);

  const refreshProfile = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) throw error;
      if (!data.user) {
        userId.current = null;
        setState({ session: null, user: null, profile: null, loading: false, profileError: null, profileErrorDetails: null, passwordRecovery: false, inactivityWarning: null });
        return;
      }
      const userChanged = userId.current !== data.user.id;
      userId.current = data.user.id;
      if (userChanged) {
        setState((prev) => ({
          ...prev,
          user: data.user,
          profile: null,
          loading: true,
          profileError: null,
          profileErrorDetails: null,
        }));
      }
      const profile = await loadProfile(data.user.id);
      if (currentRequest === requestId.current) {
        setState((prev) => ({ ...prev, user: data.user, profile, loading: false, profileError: null, profileErrorDetails: null }));
      }
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      const { message, raw } = friendlyErrorDetails(error);
      console.error('Failed to refresh profile', error);
      setState((prev) => {
        if (prev.profile && userId.current === prev.user?.id) return prev;
        return {
          ...prev,
          profile: null,
          loading: false,
          profileError: message,
          profileErrorDetails: raw ?? null,
        };
      });
    }
  }, [loadProfile]);

  const clearPasswordRecovery = useCallback(() => {
    setState((prev) => ({ ...prev, passwordRecovery: false }));
  }, []);

  useEffect(() => {
    let mounted = true;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if (event === 'SIGNED_OUT' || !session) {
        requestId.current += 1;
        userId.current = null;
        activityMemory.current = null;
        clearStoredActivity();
        setState({ session: null, user: null, profile: null, loading: false, profileError: null, profileErrorDetails: null, passwordRecovery: false, inactivityWarning: null });
        return;
      }

      const userChanged = userId.current !== session.user.id;
      userId.current = session.user.id;
      // A real sign-in starts a fresh inactivity window. A restored session
      // (INITIAL_SESSION) keeps the stored time, so a tab idle for 30+ minutes
      // is still signed out. This runs before the inactivity effect schedules.
      if (event === 'SIGNED_IN' && userChanged) {
        const now = Date.now();
        activityMemory.current = now;
        writeStoredActivity(now);
      }
      setState((prev) => ({
        ...prev,
        session,
        user: session.user,
        profile: userChanged ? null : prev.profile,
        loading: userChanged ? true : prev.loading,
        passwordRecovery: event === 'PASSWORD_RECOVERY' || prev.passwordRecovery,
        profileError: userChanged ? null : prev.profileError,
        profileErrorDetails: userChanged ? null : prev.profileErrorDetails,
      }));

      const currentRequest = ++requestId.current;
      setTimeout(() => {
        loadProfile(session.user.id).then((profile) => {
          if (mounted && currentRequest === requestId.current) {
            setState((prev) => ({ ...prev, profile, loading: false, profileError: null, profileErrorDetails: null }));
          }
        }).catch((error: unknown) => {
          if (!mounted || currentRequest !== requestId.current) return;
          const { message, raw } = friendlyErrorDetails(error);
          console.error('Failed to load profile', error);
          setState((prev) => {
            if (!userChanged && prev.profile) return prev;
            return {
              ...prev,
              profile: null,
              loading: false,
              profileError: message,
              profileErrorDetails: raw ?? null,
            };
          });
        });
      }, 0);
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  useEffect(() => {
    const sessionUserId = state.session?.user.id;
    if (!sessionUserId) return;
    // The installed app (home-screen icon) is a personal device: keep the
    // player signed in until they tap Sign out. The 30-minute idle sign-out
    // only applies in a normal browser tab, which may be a shared computer.
    if (isStandalone()) return;
    let warningTimer: number | undefined;
    let logoutTimer: number | undefined;
    let countdownTimer: number | undefined;
    let lastActivityAt = readStoredActivity() ?? activityMemory.current ?? Date.now();
    activityMemory.current = lastActivityAt;
    let lastRescheduledAt = Number.NEGATIVE_INFINITY;
    const clearTimers = () => {
      if (warningTimer !== undefined) window.clearTimeout(warningTimer);
      if (logoutTimer !== undefined) window.clearTimeout(logoutTimer);
      if (countdownTimer !== undefined) window.clearInterval(countdownTimer);
    };
    const schedule = (activityAt: number) => {
      lastActivityAt = Math.max(lastActivityAt, activityAt);
      clearTimers();
      setState((prev) => prev.inactivityWarning === null ? prev : { ...prev, inactivityWarning: null });
      const elapsed = Math.max(0, Date.now() - lastActivityAt);
      const warningDelay = Math.max(0, INACTIVITY_TIMEOUT_MS - INACTIVITY_WARNING_MS - elapsed);
      warningTimer = window.setTimeout(() => {
        const remaining = Math.ceil(inactivityRemaining(lastActivityAt, Date.now()) / 1000);
        if (remaining > 0) setState((prev) => ({ ...prev, inactivityWarning: remaining }));
        countdownTimer = window.setInterval(() => {
          const secondsRemaining = Math.ceil(inactivityRemaining(lastActivityAt, Date.now()) / 1000);
          setState((prev) => ({ ...prev, inactivityWarning: secondsRemaining > 0 ? secondsRemaining : null }));
        }, 1000);
      }, warningDelay);
      logoutTimer = window.setTimeout(() => {
        const sharedActivity = readStoredActivity();
        if (sharedActivity !== null && sharedActivity > lastActivityAt) {
          schedule(sharedActivity);
          return;
        }
        const remaining = inactivityRemaining(lastActivityAt, Date.now());
        if (remaining > 0) {
          schedule(lastActivityAt);
          return;
        }
        try { sessionStorage.removeItem('betzone_nav'); } catch { /* ignore */ }
        activityMemory.current = null;
        clearStoredActivity();
        void supabase.auth.signOut();
      }, Math.max(0, INACTIVITY_TIMEOUT_MS - elapsed));
    };
    const onActivity = () => {
      const now = Date.now();
      if (now - lastRescheduledAt < ACTIVITY_THROTTLE_MS) return;
      lastRescheduledAt = now;
      activityMemory.current = now;
      writeStoredActivity(now);
      schedule(now);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ACTIVITY_STORAGE_KEY) return;
      const sharedActivity = parseActivityTimestamp(event.newValue);
      if (sharedActivity !== null && sharedActivity > lastActivityAt) schedule(sharedActivity);
    };
    const activityEvents: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'scroll'];
    activityEvents.forEach((event) => window.addEventListener(event, onActivity, { passive: true }));
    window.addEventListener('storage', onStorage);
    schedule(lastActivityAt);
    return () => {
      clearTimers();
      activityEvents.forEach((event) => window.removeEventListener(event, onActivity));
      window.removeEventListener('storage', onStorage);
    };
  }, [state.session?.user.id]);

  const signOut = async () => {
    try {
      sessionStorage.removeItem('betzone_nav');
    } catch { /* ignore */ }
    activityMemory.current = null;
    clearStoredActivity();
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ ...state, refreshProfile, signOut, clearPasswordRecovery }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
