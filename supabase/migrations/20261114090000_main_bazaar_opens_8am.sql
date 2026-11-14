/*
# Main Bazaar betting opens at 8:00 AM IST

Main Bazaar used to open at midnight, which overlapped the previous day's
close result (posted at 12:10 AM). Betting now opens at 8:00 AM, the same as
Kalyan. All other Main Bazaar times are unchanged:
open bets close 9:45 PM, open result 10:00 PM, close bets close 11:45 PM,
close result 12:10 AM the next day.
*/

UPDATE game_schedule
SET bets_open = '08:00'
WHERE game = 'test2';
