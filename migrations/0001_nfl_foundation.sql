-- NFL Props data foundation (Phase 1).
-- Written by the builder only; the Worker reads. Nothing here is MLB's.
--
-- TIME-AWARENESS
--   *_week / *_game tables hold FACTS keyed by the week they happened in.
--   Tables with `as_of_week` hold STATE ENTERING that week: they are computed
--   from games with week < as_of_week only. as_of_week = 8 means Weeks 1-7.
--   A historical row is never recomputed from later weeks.
--
-- SNAP COUNTS are deliberately absent (licensing unclear). A licensed source
-- would add its own table keyed (season, week, player_id); nothing here
-- depends on it.

CREATE TABLE IF NOT EXISTS nfl_teams (
  team_id TEXT PRIMARY KEY,
  abbreviation TEXT NOT NULL,
  display_name TEXT NOT NULL,
  city TEXT NOT NULL,
  nickname TEXT NOT NULL,
  conference TEXT,
  division TEXT
);

CREATE TABLE IF NOT EXISTS nfl_games (
  game_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  season_type TEXT NOT NULL,
  game_type TEXT,
  week INTEGER NOT NULL,
  kickoff_utc TEXT,
  gameday TEXT,
  weekday TEXT,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  location TEXT,
  roof TEXT,
  surface TEXT,
  stadium_id TEXT,
  stadium TEXT,
  home_rest INTEGER,
  away_rest INTEGER,
  home_score INTEGER,
  away_score INTEGER,
  status TEXT NOT NULL,
  spread_line REAL,
  total_line REAL,
  home_implied_total REAL,
  away_implied_total REAL,
  home_moneyline INTEGER,
  away_moneyline INTEGER,
  home_qb_id TEXT,
  away_qb_id TEXT,
  home_qb_name TEXT,
  away_qb_name TEXT,
  espn_id TEXT,
  pfr_id TEXT,
  gsis_id TEXT,
  old_game_id TEXT,
  ftn_id TEXT,
  temp REAL,
  wind REAL
);
CREATE INDEX IF NOT EXISTS nfl_games_season_week ON nfl_games (season, week);

CREATE TABLE IF NOT EXISTS nfl_players (
  player_id TEXT PRIMARY KEY,
  display_name TEXT,
  first_name TEXT,
  last_name TEXT,
  football_name TEXT,
  position TEXT,
  position_group TEXT,
  birth_date TEXT,
  headshot_url TEXT,
  latest_team_id TEXT,
  latest_status TEXT,
  latest_season INTEGER,
  latest_week INTEGER,
  espn_id TEXT,
  pfr_id TEXT,
  sleeper_id TEXT,
  sportradar_id TEXT,
  pff_id TEXT
);

CREATE TABLE IF NOT EXISTS nfl_rosters (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  position TEXT,
  depth_chart_position TEXT,
  jersey_number INTEGER,
  status TEXT,
  status_detail TEXT,
  PRIMARY KEY (season, week, player_id)
);
CREATE INDEX IF NOT EXISTS nfl_rosters_team ON nfl_rosters (season, week, team_id);

-- One row per skill player per game week. `played` is decided without snap
-- counts (see etl/nfl/derive.mjs). When played = 0 every stat is NULL.
CREATE TABLE IF NOT EXISTS nfl_player_week (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  is_home INTEGER,
  position TEXT,
  roster_status TEXT,
  played INTEGER NOT NULL,
  not_played_reason TEXT,
  has_stat_line INTEGER NOT NULL,
  attempts INTEGER,
  completions INTEGER,
  passing_yards INTEGER,
  passing_tds INTEGER,
  interceptions INTEGER,
  sacks INTEGER,
  passing_air_yards INTEGER,
  dropbacks INTEGER,
  deep_attempts INTEGER,
  scrambles INTEGER,
  designed_runs INTEGER,
  passing_epa REAL,
  carries INTEGER,
  rushing_yards INTEGER,
  rushing_tds INTEGER,
  rushing_epa REAL,
  rush_success INTEGER,
  runs_10plus INTEGER,
  rz_carries INTEGER,
  gl_carries INTEGER,
  targets INTEGER,
  receptions INTEGER,
  receiving_yards INTEGER,
  receiving_tds INTEGER,
  receiving_air_yards INTEGER,
  receiving_yac INTEGER,
  receiving_epa REAL,
  rz_targets INTEGER,
  short_targets INTEGER,
  receptions_20plus INTEGER,
  team_carries INTEGER,
  team_rb_carries INTEGER,
  team_targets INTEGER,
  team_air_yards INTEGER,
  carry_share REAL,
  backfield_carry_share REAL,
  target_share REAL,
  air_yards_share REAL,
  PRIMARY KEY (season, week, player_id)
);
CREATE INDEX IF NOT EXISTS nfl_player_week_player ON nfl_player_week (player_id, season, week);
CREATE INDEX IF NOT EXISTS nfl_player_week_team ON nfl_player_week (season, week, team_id);

-- Offense per game (from play-by-play, with the official box totals beside it).
CREATE TABLE IF NOT EXISTS nfl_team_week (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  plays INTEGER,
  dropbacks INTEGER,
  pass_att INTEGER,
  sacks_allowed INTEGER,
  qb_hits_allowed INTEGER,
  scrambles INTEGER,
  rush_att INTEGER,
  rush_yds INTEGER,
  rush_stuffed INTEGER,
  rb_carries INTEGER,
  rb_rush_yds INTEGER,
  neutral_plays INTEGER,
  neutral_dropbacks INTEGER,
  pass_oe_sum REAL,
  pass_oe_n INTEGER,
  team_targets INTEGER,
  team_air_yds INTEGER,
  box_attempts INTEGER,
  box_completions INTEGER,
  box_passing_yards INTEGER,
  box_carries INTEGER,
  box_rushing_yards INTEGER,
  PRIMARY KEY (season, week, team_id)
);

-- Defense per game: the raw sums every defensive metric is built from.
CREATE TABLE IF NOT EXISTS nfl_defense_game (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  opponent_id TEXT NOT NULL,
  dropbacks INTEGER, db_epa REAL, db_success INTEGER,
  pass_att INTEGER, completions INTEGER, pass_yds INTEGER, pass_td INTEGER, ints INTEGER,
  sacks INTEGER, sack_yds INTEGER, qb_hits INTEGER, pass_20 INTEGER,
  air_yds INTEGER, air_att INTEGER, yac INTEGER, short_att INTEGER, short_cmp INTEGER,
  scrambles INTEGER, scramble_yds INTEGER,
  rush_att INTEGER, rush_yds INTEGER, rush_epa REAL, rush_success INTEGER,
  rush_10 INTEGER, rush_20 INTEGER, rush_stuffed INTEGER, rush_fd INTEGER, rush_td INTEGER, rz_rush_att INTEGER,
  rb_tgt INTEGER, rb_rec INTEGER, rb_rec_yds INTEGER, rb_rec_td INTEGER, rb_air_yds INTEGER,
  rb_car INTEGER, rb_rush_yds INTEGER, rb_rush_td INTEGER,
  wr_tgt INTEGER, wr_rec INTEGER, wr_rec_yds INTEGER, wr_rec_td INTEGER, wr_air_yds INTEGER,
  te_tgt INTEGER, te_rec INTEGER, te_rec_yds INTEGER, te_rec_td INTEGER, te_air_yds INTEGER,
  team_tgt INTEGER,
  PRIMARY KEY (season, week, team_id)
);

-- Defensive metrics ENTERING as_of_week (games with week < as_of_week).
-- rank: 1 = strongest defense. percentile: 100 = strongest, 0 = weakest.
CREATE TABLE IF NOT EXISTS nfl_defense_week (
  season INTEGER NOT NULL,
  as_of_week INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  sample_window TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL,
  league_avg REAL,
  rank INTEGER,
  percentile REAL,
  games INTEGER NOT NULL,
  sample REAL,
  small_sample INTEGER NOT NULL,
  PRIMARY KEY (season, as_of_week, team_id, sample_window, metric_key)
);

CREATE TABLE IF NOT EXISTS nfl_defense_position_week (
  season INTEGER NOT NULL,
  as_of_week INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  position TEXT NOT NULL,
  sample_window TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  value REAL,
  league_avg REAL,
  rank INTEGER,
  percentile REAL,
  games INTEGER NOT NULL,
  sample REAL,
  small_sample INTEGER NOT NULL,
  PRIMARY KEY (season, as_of_week, team_id, position, sample_window, metric_key)
);

-- A player's usage ENTERING as_of_week, over games played (season, L5, L3).
CREATE TABLE IF NOT EXISTS nfl_player_usage_week (
  season INTEGER NOT NULL,
  as_of_week INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  team_id TEXT,
  position TEXT,
  sample_window TEXT NOT NULL,
  games INTEGER NOT NULL,
  first_week INTEGER,
  last_week INTEGER,
  attempts_pg REAL, completions_pg REAL, passing_yards_pg REAL, dropbacks_pg REAL,
  ypa REAL, completion_pct REAL, pass_adot REAL, deep_attempt_rate REAL, sack_rate REAL, scramble_rate REAL,
  carries_pg REAL, rushing_yards_pg REAL, ypc REAL, rush_success_rate REAL, explosive_run_rate REAL,
  carry_share REAL, backfield_carry_share REAL, rz_carries INTEGER, gl_carries INTEGER,
  targets_pg REAL, receptions_pg REAL, receiving_yards_pg REAL,
  target_share REAL, air_yards_share REAL, adot REAL, catch_rate REAL, yards_per_target REAL,
  yards_per_reception REAL, yac_per_reception REAL, short_target_share REAL, receptions_20plus INTEGER, rz_targets INTEGER,
  touches_pg REAL,
  PRIMARY KEY (season, as_of_week, player_id, sample_window)
);

-- Team offensive tendencies ENTERING as_of_week.
CREATE TABLE IF NOT EXISTS nfl_team_tendency_week (
  season INTEGER NOT NULL,
  as_of_week INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  games INTEGER NOT NULL,
  plays_pg REAL, pass_rate REAL, rush_rate REAL, neutral_pass_rate REAL, neutral_plays INTEGER,
  pass_rate_over_expected REAL, pass_att_pg REAL, rush_att_pg REAL,
  sack_rate_allowed REAL, qb_hit_rate_allowed REAL, stuff_rate_allowed REAL, rb_ypc REAL,
  league_plays_pg REAL, league_pass_rate REAL, league_neutral_pass_rate REAL,
  PRIMARY KEY (season, as_of_week, team_id)
);

-- The official injury report as captured on a given day. The source keeps only
-- the latest status per player-week, so the daily capture is the history.
CREATE TABLE IF NOT EXISTS nfl_injuries (
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  position TEXT,
  display_name TEXT,
  game_status TEXT,
  game_status_raw TEXT,
  practice_status TEXT,
  practice_status_raw TEXT,
  report_primary_injury TEXT,
  report_secondary_injury TEXT,
  practice_primary_injury TEXT,
  practice_secondary_injury TEXT,
  reported_at TEXT,
  captured_date TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (season, week, player_id, captured_date)
);
CREATE INDEX IF NOT EXISTS nfl_injuries_team ON nfl_injuries (season, week, team_id);

CREATE TABLE IF NOT EXISTS nfl_depth_charts (
  season INTEGER NOT NULL,
  team_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT,
  pos_group TEXT,
  pos_name TEXT,
  pos_abb TEXT NOT NULL,
  pos_slot INTEGER NOT NULL,
  pos_rank INTEGER NOT NULL,
  PRIMARY KEY (season, team_id, pos_abb, pos_slot, pos_rank, player_id)
);

-- Game context as known on captured_date. Weather columns stay NULL until a
-- licensed weather provider is connected; no value is ever invented.
CREATE TABLE IF NOT EXISTS nfl_game_environment (
  game_id TEXT NOT NULL,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  captured_date TEXT NOT NULL,
  as_of_week INTEGER NOT NULL,
  kickoff_utc TEXT,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  location TEXT,
  stadium TEXT,
  roof TEXT,
  surface TEXT,
  home_rest INTEGER,
  away_rest INTEGER,
  spread_line REAL,
  total_line REAL,
  home_implied_total REAL,
  away_implied_total REAL,
  lines_source TEXT,
  home_plays_pg REAL, home_pass_rate REAL, home_neutral_pass_rate REAL, home_proe REAL,
  away_plays_pg REAL, away_pass_rate REAL, away_neutral_pass_rate REAL, away_proe REAL,
  weather_temperature_f REAL,
  weather_wind_mph REAL,
  weather_gust_mph REAL,
  weather_precip_probability REAL,
  weather_precip_in REAL,
  weather_updated_at TEXT,
  weather_source TEXT,
  PRIMARY KEY (game_id, captured_date)
);

-- Provenance of every source file a build consumed.
CREATE TABLE IF NOT EXISTS nfl_data_snapshots (
  build_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  season INTEGER NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  retrieved_at TEXT,
  source_last_modified TEXT,
  etag TEXT,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  rows_total INTEGER,
  archive_key TEXT,
  PRIMARY KEY (build_id, dataset, season)
);

CREATE TABLE IF NOT EXISTS nfl_builds (
  build_id TEXT PRIMARY KEY,
  season INTEGER NOT NULL,
  as_of_week INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  checks_json TEXT,
  counts_json TEXT
);

-- What the builder last wrote for each slice of each table, so a re-run with
-- the same data writes nothing.
CREATE TABLE IF NOT EXISTS nfl_partitions (
  table_name TEXT NOT NULL,
  part TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  build_id TEXT NOT NULL,
  written_at TEXT NOT NULL,
  PRIMARY KEY (table_name, part)
);
