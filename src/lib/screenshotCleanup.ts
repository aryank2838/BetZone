import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';

const LAST_RUN_KEY = 'screenshot-cleanup-last-run';
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const MAX_BATCHES = 10;

function readLastRun(): number {
  try { return Number(window.localStorage.getItem(LAST_RUN_KEY)) || 0; } catch { return 0; }
}

function writeLastRun(value: number) {
  try { window.localStorage.setItem(LAST_RUN_KEY, String(value)); } catch { /* storage unavailable */ }
}

/**
 * Deletes payment screenshots of requests settled more than 30 days ago, to
 * stay inside Supabase's free storage. The database decides which files are
 * old enough and refuses to let anything newer be deleted. Returns how many
 * screenshots were removed.
 */
export async function cleanupOldScreenshots(): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { data: paths, error } = await supabase.rpc('admin_old_screenshot_paths', { p_limit: BATCH_SIZE });
    if (error) throw error;
    const list = (paths as string[] | null) ?? [];
    if (list.length === 0) break;
    const { error: removeError } = await supabase.storage.from('payment-screenshots').remove(list);
    if (removeError) throw removeError;
    const { data: marked, error: markError } = await supabase.rpc('admin_mark_screenshots_removed', { p_paths: list });
    if (markError) throw markError;
    const count = Number(marked) || 0;
    removed += count;
    // Nothing could be marked (files not deleted): stop instead of looping.
    if (count === 0 || list.length < BATCH_SIZE) break;
  }
  return removed;
}

/** Admin-only: runs the cleanup in the background at most once a day per device. */
export function useScreenshotCleanup() {
  useEffect(() => {
    if (Date.now() - readLastRun() < RUN_EVERY_MS) return;
    const timer = window.setTimeout(() => {
      writeLastRun(Date.now());
      cleanupOldScreenshots().catch((error: unknown) => {
        console.error('Payment screenshot cleanup failed', error);
      });
    }, 10_000); // let the admin screens load first
    return () => window.clearTimeout(timer);
  }, []);
}
