// send-push: delivers queued player notifications (push_outbox) as Web Push.
// Called every minute by pg_cron, but only while the queue has unsent rows,
// with the x-cron-secret header.
//
// Function secrets:
//   PUSH_CRON_SECRET   shared with the cron job (Vault: push_cron_secret)
//   VAPID_PUBLIC_KEY   same value as VAPID_PUBLIC_KEY in src/lib/push.ts
//   VAPID_PRIVATE_KEY  never commit this
//   VAPID_SUBJECT      contact for push services, e.g. https://your-site.example
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { sendPush, type VapidKeys } from '../_shared/webpush.ts';
import { buildMessage, groupOutbox, normalizeLanguage, type OutboxRow } from './messages.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function sameSecret(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  language: string;
}

/** Sends to many subscriptions, a few at a time. */
async function runLimited<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await task(item);
    }
  });
  await Promise.all(workers);
}

Deno.serve(async (req) => {
  const cronSecret = Deno.env.get('PUSH_CRON_SECRET') ?? '';
  const given = req.headers.get('x-cron-secret') ?? '';
  if (!cronSecret || !sameSecret(given, cronSecret)) return json({ error: 'Unauthorized' }, 401);

  const vapid: VapidKeys = {
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    subject: Deno.env.get('VAPID_SUBJECT') ?? '',
  };
  if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) {
    return json({ error: 'VAPID keys are not configured' }, 500);
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  // Claiming marks rows as sent, so two overlapping runs never send twice.
  const { data: claimed, error: claimError } = await supabase.rpc('push_claim_outbox', { p_limit: 500 });
  if (claimError) return json({ error: claimError.message }, 500);
  const rows = (claimed ?? []) as OutboxRow[];
  if (rows.length === 0) return json({ claimed: 0, sent: 0 });

  const events = groupOutbox(rows);
  const userIds = [...new Set(events.map((event) => event.user_id))];
  const { data: subs, error: subsError } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth, language')
    .in('user_id', userIds);
  if (subsError) return json({ error: subsError.message }, 500);

  const byUser = new Map<string, SubscriptionRow[]>();
  for (const sub of (subs ?? []) as SubscriptionRow[]) {
    byUser.set(sub.user_id, [...(byUser.get(sub.user_id) ?? []), sub]);
  }

  const jobs = events.flatMap((event) => (byUser.get(event.user_id) ?? []).map((sub) => ({ event, sub })));
  const gone: string[] = [];
  const failed: string[] = [];
  const delivered: string[] = [];
  let sent = 0;

  await runLimited(jobs, 10, async ({ event, sub }) => {
    const message = buildMessage(event.kind, event.amount, event.reason, normalizeLanguage(sub.language));
    try {
      const { result } = await sendPush(sub, message, vapid, {
        urgency: 'high',
        // A match reminder is useless after kick-off, so it expires in 30 minutes.
        ttlSeconds: event.kind === 'match_starting' ? 30 * 60 : event.kind === 'winnings' ? 6 * 60 * 60 : 24 * 60 * 60,
      });
      if (result === 'sent') {
        sent += 1;
        delivered.push(sub.id);
      } else if (result === 'gone') {
        gone.push(sub.id);
      } else {
        failed.push(sub.id);
      }
    } catch (error) {
      console.error('push failed', sub.id, error instanceof Error ? error.message : String(error));
      failed.push(sub.id);
    }
  });

  // Expired subscriptions are removed; others that keep failing are removed
  // after several failed runs (push_record_results).
  const { error: recordError } = await supabase.rpc('push_record_results', {
    p_gone: gone,
    p_failed: failed,
    p_delivered: delivered,
  });
  if (recordError) console.error('push_record_results failed', recordError.message);

  return json({ claimed: rows.length, notifications: jobs.length, sent, gone: gone.length, failed: failed.length });
});
