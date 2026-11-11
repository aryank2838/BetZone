DROP FUNCTION IF EXISTS public.post_open_result(text, text, text);
DROP FUNCTION IF EXISTS public.post_close_result(text, text, text);
DROP FUNCTION IF EXISTS public.get_latest_winning_number(text);
DROP FUNCTION IF EXISTS public.is_game_open(text);

DROP TABLE IF EXISTS public.winning_numbers;
DROP TABLE IF EXISTS public.ad_rewards;
