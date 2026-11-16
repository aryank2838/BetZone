/*
Run the sports-sync Edge Function every 10 minutes.

The job reads two Vault secrets, so nothing secret is stored in this file:
  sports_sync_url     https://<project-ref>.supabase.co/functions/v1/sports-sync
  sports_cron_secret  the same value as the function's SPORTS_CRON_SECRET
Until both exist the job runs but does nothing (the function returns 401).
*/
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sports-sync') THEN
    PERFORM cron.unschedule('sports-sync');
  END IF;
  PERFORM cron.schedule(
    'sports-sync',
    '*/10 * * * *',
    $job$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_sync_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'sports_cron_secret')
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      )
      WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'sports_sync_url');
    $job$
  );
END;
$cron$;
