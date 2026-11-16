/*
Cricket requests go out through pg_net from the database.

cricketdata.org resets connections from the Edge Function network but
accepts the database's. So the sports-sync function asks the database to
send each request (cricket_http_get), remembers the request id in
sport_feed_requests, and on its next run reads the reply
(cricket_http_result). The key stays in Vault (secret 'cricket_api_key') and
is only read here. Replies are deleted once read, because cricketdata.org
echoes the key back in every reply.
*/

CREATE TABLE public.sport_feed_requests (
  request_id bigint PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('discovery', 'series')),
  ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sport_feed_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sport_feed_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.sport_feed_requests TO service_role;

-- Calls used today, as reported by cricketdata.org.
ALTER TABLE public.sport_feed_state ADD COLUMN IF NOT EXISTS value integer;

CREATE OR REPLACE FUNCTION public.cricket_http_get(p_path text, p_params jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF p_path IS NULL OR p_path NOT IN ('series', 'series_info') THEN
    RAISE EXCEPTION 'Unknown cricket request';
  END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'cricket_api_key';
  IF v_key IS NULL OR v_key = '' THEN
    RAISE EXCEPTION 'The cricket key is not set (Vault secret cricket_api_key).';
  END IF;
  RETURN net.http_get(
    url := 'https://api.cricapi.com/v1/' || p_path,
    params := COALESCE(p_params, '{}'::jsonb) || jsonb_build_object('apikey', v_key),
    timeout_milliseconds := 30000
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cricket_http_get(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cricket_http_get(text, jsonb) TO service_role;

-- NULL while the reply has not arrived. Removes the echoed key and deletes the reply.
CREATE OR REPLACE FUNCTION public.cricket_http_result(p_request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status integer;
  v_error text;
  v_content text;
  v_timed_out boolean;
  v_body jsonb;
BEGIN
  SELECT status_code, error_msg, content, timed_out
  INTO v_status, v_error, v_content, v_timed_out
  FROM net._http_response WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  BEGIN
    v_body := v_content::jsonb - 'apikey';
  EXCEPTION WHEN OTHERS THEN
    v_body := NULL;
  END;
  DELETE FROM net._http_response WHERE id = p_request_id;

  RETURN jsonb_build_object(
    'status_code', v_status,
    'error', CASE WHEN COALESCE(v_timed_out, false) THEN 'timed out' ELSE v_error END,
    'body', v_body
  );
END;
$$;
REVOKE EXECUTE ON FUNCTION public.cricket_http_result(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cricket_http_result(bigint) TO service_role;
