/*
# Betting closes 10 minutes before each result

Kalyan and Main Bazaar used to close 15 minutes before their results. They now
match Milan Day and Milan Night and close 10 minutes before. The one exception
is Main Bazaar's close bets: they close at 11:55 PM, 15 minutes before the
12:10 AM close result. All times are IST.

| game  | label       | open bets close | open result | close bets close | close result |
|-------|-------------|-----------------|-------------|------------------|--------------|
| test  | Kalyan      | 15:35 (was 15:30) | 15:45     | 17:35 (was 17:30) | 17:45       |
| test2 | Main Bazaar | 21:50 (was 21:45) | 22:00     | 23:55 (was 23:45) | 00:10 next day |
| test3 | Milan Day   | 14:55           | 15:05       | 16:55            | 17:05        |
| test4 | Milan Night | 20:55           | 21:05       | 22:55            | 23:05        |

Milan Day and Milan Night already close 10 minutes before, so they are not
changed. Every cutoff is later than before, so no bet already placed falls
outside its window.
*/

UPDATE public.game_schedule
SET open_bets_close = '15:35',
    close_bets_close = '17:35'
WHERE game = 'test';

UPDATE public.game_schedule
SET open_bets_close = '21:50',
    close_bets_close = '23:55'
WHERE game = 'test2';
