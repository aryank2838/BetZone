ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  v_function record;
BEGIN
  FOR v_function IN
    SELECT p.oid::regprocedure AS function_signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind IN ('f', 'p', 'a', 'w')
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON ROUTINE %s FROM PUBLIC, anon, authenticated',
      v_function.function_signature
    );
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_patti(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.patti_digit(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_valid_patti_combo(text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.submit_selection(text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_game_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_latest_results(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_all_latest_results() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wallet_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_balance_breakdown() TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_withdrawal(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_add_funds(integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_app_setting(text) TO authenticated;

GRANT EXECUTE ON FUNCTION public.admin_post_open_result(text, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_post_close_result(text, date, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_stats(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_selections(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_withdrawals(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_add_funds(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_process_withdrawal(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_process_add_funds(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_toggle_ban(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_admin(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_points(uuid, integer, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_app_setting(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_exposure(text, date) TO authenticated;
