/*
# Add Milan Day and Milan Night

Two new games, using the same bet types and payout rates as Kalyan and
Main Bazaar. Betting closes 10 minutes before each result and opens 12 hours
before the open result. All times are IST.

| game  | label       | opens | open bets close | open result | close bets close | close result |
|-------|-------------|-------|-----------------|-------------|------------------|--------------|
| test3 | Milan Day   | 03:05 | 14:55           | 15:05       | 16:55            | 17:05        |
| test4 | Milan Night | 09:05 | 20:55           | 21:05       | 22:55            | 23:05        |

Internal IDs follow the existing 'test' / 'test2' pattern so the server's
ORDER BY game keeps the order Kalyan, Main Bazaar, Milan Day, Milan Night.
Every betting, result, payout, report and holiday function reads the game list
from game_schedule, so no function changes are needed.
*/

INSERT INTO public.game_schedule (
  game, label, bets_open, open_bets_close, close_bets_close,
  open_result_at, close_result_at, close_result_next_day
)
VALUES
  ('test3', 'Milan Day',   '03:05', '14:55', '16:55', '15:05', '17:05', false),
  ('test4', 'Milan Night', '09:05', '20:55', '22:55', '21:05', '23:05', false)
ON CONFLICT (game) DO UPDATE SET
  label = EXCLUDED.label,
  bets_open = EXCLUDED.bets_open,
  open_bets_close = EXCLUDED.open_bets_close,
  close_bets_close = EXCLUDED.close_bets_close,
  open_result_at = EXCLUDED.open_result_at,
  close_result_at = EXCLUDED.close_result_at,
  close_result_next_day = EXCLUDED.close_result_next_day;
