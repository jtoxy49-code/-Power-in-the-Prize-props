-- NFL odds refresh: the run ledger, which is also the lock.
--
-- One row per time the 10-minute cron reaches the NFL odds refresh while it is
-- switched on. An "attempt" row is inserted BEFORE the first request to the
-- provider, by a single conditional INSERT that succeeds only when no other
-- attempt started inside the minimum interval. D1 runs that statement
-- atomically, so of two invocations starting together exactly one gets the
-- row and may call the provider. The row is then completed with what the run
-- did. A run that is killed leaves its row at outcome 'started'.
--
-- kind     'attempt'  the run claimed the lock and called the provider
--          'skip'     the run did not call the provider (reason says why)
-- outcome  'started'  claimed, never finished (crashed or killed)
--          'success'  every sweep it made was complete, and it stored odds
--          'partial'  it stored odds, and at least one sweep was cut short
--          'failed'   nothing was retrieved, or an error; nothing was stored
--          'skipped'  for kind 'skip'
-- source   'live' when the rows came from the provider through the real
--          fetch; 'fixture' for anything built from test data or a capture.
-- detail_json  the games on the slate, the FanDuel games planned, and per
--          sweep: requests, rows, why it stopped, and per game and prop the
--          markets with a main line and the provider's newest timestamp.

CREATE TABLE IF NOT EXISTS nfl_odds_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  kind TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  source TEXT,
  requests INTEGER,
  provider_requests_left INTEGER,
  detail_json TEXT
);

CREATE INDEX IF NOT EXISTS nfl_odds_runs_started ON nfl_odds_runs (started_at);
