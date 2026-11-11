CREATE TABLE IF NOT EXISTS game_schedule (
  game text PRIMARY KEY,
  label text NOT NULL,
  bets_open time NOT NULL,
  open_bets_close time NOT NULL,
  close_bets_close time NOT NULL,
  open_result_at time NOT NULL,
  close_result_at time NOT NULL,
  close_result_next_day boolean NOT NULL DEFAULT false
);

ALTER TABLE game_schedule ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON game_schedule TO authenticated;

DROP POLICY IF EXISTS schedule_read ON game_schedule;
CREATE POLICY schedule_read ON game_schedule
  FOR SELECT TO authenticated
  USING (true);

INSERT INTO game_schedule (
  game, label, bets_open, open_bets_close, close_bets_close,
  open_result_at, close_result_at, close_result_next_day
)
VALUES
  ('test', 'Kalyan', '08:00', '15:30', '17:30', '15:45', '17:45', false),
  ('test2', 'Main Bazaar', '00:00', '21:45', '23:45', '22:00', '00:00', true)
ON CONFLICT (game) DO UPDATE SET
  label = EXCLUDED.label,
  bets_open = EXCLUDED.bets_open,
  open_bets_close = EXCLUDED.open_bets_close,
  close_bets_close = EXCLUDED.close_bets_close,
  open_result_at = EXCLUDED.open_result_at,
  close_result_at = EXCLUDED.close_result_at,
  close_result_next_day = EXCLUDED.close_result_next_day;
