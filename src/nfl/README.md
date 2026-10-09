# NFL Props: module boundary and API contracts (Phase 1)

NFL code lives here and in `etl/nfl/`. No NFL calculation is in an MLB file.
The only edits outside these folders are four additive lines in
`src/index.js` (two imports, one route mount, one gated cron call), the D1
binding and one variable in `wrangler.toml`, and two ignore lines in
`.gitignore`.

## Layers

| Layer | Where | What it does |
|---|---|---|
| Ingestion | `etl/nfl/sources.mjs`, `etl/nfl/csv.mjs` | Downloads nflverse release files, checks required columns, records provenance |
| Normalization | `src/nfl/teams.js`, `src/nfl/players.js` | One team table; name-to-player resolution with quarantine |
| Derived metrics | `etl/nfl/derive.mjs`, `src/nfl/metrics.js` | Weekly facts, as-of-week state, defensive ranks, defense versus position, usage |
| Storage output | `etl/nfl/sql.mjs`, `etl/nfl/payloads.mjs`, `etl/nfl/publish.mjs` | D1 slices that changed, KV serving payloads, wrangler publish |
| Odds | `src/nfl/props.js`, `src/nfl/odds-rules.js`, `src/nfl/odds.js`, `src/nfl/odds-runs.js` | Allowlist, main-line rule, freshness, paging with cursor recovery, KV write, run ledger and lock |
| API | `src/nfl/api.js`, `src/nfl/research.js` | `/api/nfl/*`, reading KV only |
| Frontend | `public/assets/js/nfl/` | Not started. No NFL UI exists. |

The builder (`etl/nfl/build.mjs`) runs outside the Worker. The Worker never
loads play-by-play and never writes a data table in D1. Its one D1 table is
`nfl_odds_runs` (migration 0002): the odds refresh's run ledger and lock.

## Identifiers

`sport = "nfl"`, `season`, `week`, `game_id` (nflverse, `2026_04_TEN_BAL`),
`player_id` (GSIS, `00-0034796`), `team_id` and `opponent_id` (nflverse
abbreviation; Rams `LA`, Raiders `LV`, Washington `WAS`, Jacksonville `JAX`),
`position`, `event_time` (`kickoff_utc`, from the schedule). Odds add
`prop_type`, `market_type`, `sportsbook`, `line`, `side`, `price`, and two
timestamps: `seen_at` (the provider's) and `fetched_at` (ours). Names are
display fields and are never a key.

`as_of_week = N` means the state entering Week N: games with `week < N` only.

## Routes

All `GET`, all behind the existing session and Premium gates, all answering
`cache-control: private`. Errors are `{ "error": "..." }` with 400, 404, 405, or 503 when no
complete build can be read.

### `/api/nfl/meta`
`{ sport, season, week, as_of_week, data_through_week, build_id, built_at, modules: { snap_counts, routes, coverage, weather, model }, module_notes, archive: { status, files }, sources: [{ dataset, url, retrieved_at, source_last_modified, sha256, bytes, rows_total }], counts, checks: [{ name, ok, detail }], games_awaiting_stats, attribution }`

`games_awaiting_stats` lists games the schedule calls final whose play-by-play
the source has not published yet. They are in no game log or aggregate, and
the as-of week does not advance past them.

### `/api/nfl/teams`
`{ teams: [{ team_id, abbreviation, display_name, city, nickname, conference, division }] }`

### `/api/nfl/slate`
`{ season, week, as_of_week, build_id, games: [{ game_id, season_type, week, kickoff_utc, home_team_id, away_team_id, location, stadium, roof, surface, home_rest, away_rest, status, home_qb_id, away_qb_id, home_qb_name, away_qb_name, environment }] }`

`environment`: `{ spread_line, total_line, home_implied_total, away_implied_total, spread_convention, lines_source, home: { plays_pg, pass_rate, neutral_pass_rate, pass_rate_over_expected }, away: {...}, weather: { status, temperature_f, wind_mph, gust_mph, precip_probability, updated_at } }`.
`spread_line` is positive when the home team is favored. `weather.status` is
`"indoors"` or `"not_configured"`; every weather number is null until a
licensed provider is connected.

### `/api/nfl/odds[?game=<game_id>][&player=<player_id>][&exposed=all][&ladders=1]`
`{ sport, season, week, updated_at, source, coverage, freshness_rule: { fresh_minutes, stale_minutes }, games: { <game_id>: { event_id, kickoff_utc, books: { <sportsbook>: { fetched_at, markets } } } }, markets: [...], counts, runs }`

A market: `{ market_id, game_id, player_id, player_name, team_id, position, prop_type, market_type, exposed, books: [...], best }`.

`updated_at` is the time of the last run that retrieved anything. It says
nothing about a particular book or game. `coverage` does: per sportsbook,
`{ games, fresh, aging, stale, never_fetched, with_lines, oldest_fetched_at, newest_fetched_at }`
over the pregame games, computed when the request is served. A market whose
game has kicked off is not returned, whatever is still stored for it.

A book entry: `{ sportsbook, fetched_at, seen_at, age_minutes, status, main: { line, over, under, over_implied, under_implied, hold, two_sided_lines } | null, ladder_count, provider_flagged_line }`.
`status` is `fresh` (15 minutes or less), `aging` (to 30) or `stale`.
`fetched_at` is when our refresh last retrieved that book's rows for that
game completely; `seen_at` is the provider's own newest timestamp on the
market. They are separate fields and neither is derived from the other.

Ladders (a book's alternate rungs, in practice FanDuel's over-only ladder) are
not returned by default. `ladders=1` adds `ladder: [{ line, over, under }]` to
each book entry, here and on `/api/nfl/research`.

`best`: `{ lines_differ, lines: [{ line, books, best_over, best_under, compared_books, stale_books }] }`.
Prices are compared only between books posting the same number. A stale book
is never `best_over` or `best_under`.

By default only markets V1 exposes are returned (QB passing yards, RB rushing
yards, WR and TE receiving yards and receptions). `exposed=all` adds stored
rows such as a quarterback's rushing yards.

### `/api/nfl/player?id=<player_id>`
`{ season, as_of_week, data_through_week, build_id, team, player: { player_id, display_name, position, team_id, jersey_number, roster_status, headshot_url, ids, depth_chart, injury, usage: { season, L5, L3 }, game_log: [...] } }`

A usage window: `{ games, first_week, last_week, attempts_pg, completions_pg, passing_yards_pg, dropbacks_pg, ypa, completion_pct, pass_adot, deep_attempt_rate, sack_rate, scramble_rate, carries_pg, rushing_yards_pg, ypc, rush_success_rate, explosive_run_rate, carry_share, backfield_carry_share, rz_carries, gl_carries, targets_pg, receptions_pg, receiving_yards_pg, target_share, air_yards_share, adot, catch_rate, yards_per_target, yards_per_reception, yac_per_reception, short_target_share, receptions_20plus, rz_targets, touches_pg }`. There is no snap or route field.

A game-log row: `{ week, game_id, opponent_id, is_home, team_id, played, not_played_reason, roster_status, attempts, completions, passing_yards, passing_tds, interceptions, sacks, dropbacks, deep_attempts, scrambles, carries, rushing_yards, rushing_tds, runs_10plus, rz_carries, carry_share, backfield_carry_share, targets, receptions, receiving_yards, receiving_tds, receiving_air_yards, receptions_20plus, rz_targets, target_share, air_yards_share }`.
When `played` is 0 every stat is null.

### `/api/nfl/gamelog?id=<player_id>`
`{ player_id, season, as_of_week, build_id, game_log }`

### `/api/nfl/defense?team=<team_id>`
`{ season, as_of_week, data_through_week, team_id, games, opponents: [{ week, opponent_id }], metrics: { <metric_key>: { value, rank, percentile, sample, small_sample } }, vs_position: { RB: {...}, WR: {...}, TE: {...} }, league: { <metric_key>: value }, league_vs_position, registry }`

Rank 1 is the strongest defense. Percentile 100 is the strongest.

### `/api/nfl/injuries[?team=<team_id>]`
`{ season, week, captured_date, note, team_id, injuries: [{ player_id, display_name, position, game_status, practice_status, report_primary_injury, practice_primary_injury, reported_at, captured_date }], depth_chart_snapshot_at, depth_chart: [{ player_id, display_name, pos_abb, pos_slot, pos_rank, pos_group }] }`

`game_status`: `OUT`, `DOUBTFUL`, `QUESTIONABLE` or null. `practice_status`:
`DNP`, `LIMITED`, `FULL` or null. `reported_at` is null: the source carries no
report time.

### `/api/nfl/research?player=<player_id>[&prop=<prop_type>][&ladders=1]`
One payload for a player and a prop: the future Player Detail's data.

`{ sport, season, week, as_of_week, data_through_week, build_id, player, prop: { prop_type, label, stat, market_type, exposed_in_v1 }, game, environment, odds, samples: { season, L5, L10, H2H }, usage, game_log, matchup, personnel, modules, model }`

- `odds`: `{ market_id, updated_at, books, best, default_line: { line, sportsbook } }` or null.
- A sample: `{ games, not_counted, mean, median, values, line, over, under, push, over_rate }`. A push is excluded from `over_rate`.
- `matchup`: `{ opponent_id, as_of_week, games, opponents_faced, metrics: [{ metric_key, scope, tier, label, unit, strong, kind, value, rank, of, percentile, league_avg, sample, small_sample }], classification: null }`. `tier` is `primary`, `secondary` or `context`. `scope` is `team` or `vs_RB`, `vs_WR`, `vs_TE`.
- `personnel`: `{ player_injury, teammates, offensive_line: { listed_starters, available, of, basis }, opponent_defense_out }`.
- `model`: always `null`. The reserved optional fields are `projected_mean`, `projected_median`, `lower_interval`, `upper_interval`, `prob_over`, `prob_under`, `confidence`, `model_version`, `generated_at`. Nothing produces them and every consumer must work without them.

`prop` defaults by position: QB `pass_yds`, RB `rush_yds`, WR and TE `rec_yds`.

## KV keys

A build's payloads are written under keys of their own,
`nfl:build:{build_id}:{name}`, and are never overwritten. One key,
`nfl:current`, names the build readers use.

| Key | Written by | Contents |
|---|---|---|
| `nfl:current` | builder, last | The pointer: `{ schema, current: { build_id, season, as_of_week, published_at, names }, previous, retained: [{ ..., superseded_at }] }` |
| `nfl:build:{build_id}:meta` | builder | Build stamp, source freshness, checks |
| `nfl:build:{build_id}:slate:current`, `...:slate:{season}:{week}` | builder | This week's games and environment |
| `nfl:build:{build_id}:rosters:current` | builder | Skill-position rosters, for resolving odds names |
| `nfl:build:{build_id}:team:{team_id}` (32) | builder | That team's player profiles, usage and game logs |
| `nfl:build:{build_id}:defense:{season}:{as_of_week}`, `...:defense:current` | builder | All 32 defensive profiles |
| `nfl:build:{build_id}:status:latest` | builder | Injuries and depth charts |
| `nfl:build:{build_id}:players:index` | builder | player_id to team |
| `nfl:odds:latest` | Worker cron | Current props per book with fetch times |
| `nfl:odds:unresolved` | Worker cron | Quarantined rows; never served |

The code names a payload by its plain key (`nfl:slate:current`);
`src/nfl/snapshot.js` maps that to the build being read. Keys with no build in
the name (`nfl:meta`, `nfl:slate:current`, ...) are from before this scheme and
are read only while `nfl:current` does not exist.

## Publishing a build, and what readers see if it fails

KV has no multi-key transaction and each key reaches each edge location
separately, so writing a stamp last does not make a set of keys appear
together. The publish (`etl/nfl/publish.mjs`) works on that basis:

1. Read the live pointer.
2. Write the build under its own keys. Nothing a reader uses changes.
3. Confirm every key is listed and the build's stamp reads back.
4. Wait 75 seconds. KV documents up to 60 for a write to be visible
   everywhere and gives no hard bound, so the wait lowers the chance that an
   edge sees the pointer before a payload. It does not prove it.
5. Read the pointer again (another publisher may have moved it), then write
   it: `current` is this build, `previous` the one that was live, `retained`
   every superseded build still stored, each with the time it was superseded.
6. Delete only builds superseded more than 48 hours ago (never `previous`),
   and builds no pointer lists whose own build time is more than 48 hours
   old. A failure here is logged, not fatal.

A request reads the pointer once and takes every payload from the build it
names. If a payload of that build cannot be read, the whole request is
answered again from `previous`; if that cannot be read either, the answer is
503. Each response names its build: `build_id` in the body, `x-nfl-build` in
the headers.

| Publish fails at | What readers get |
|---|---|
| checks, R2 or D1 (before KV) | The build they had. KV is untouched. |
| step 2, part of the keys written | The build they had. The new keys are never read; they are deleted once they are 48 hours old. |
| step 3 or 4 | The build they had. |
| step 5, write rejected | The build they had. |
| step 5, write landed but reported as failed | The new build, complete. The run exits 1; the next run sees it as live. |
| step 6 | The new build. Older keys stay until a later publish. |

### What is retained, and the guarantee

- The build named `current` by any pointer value that was live in the last
  48 hours is still complete in KV. KV edge caches hold a value for seconds
  to minutes; an edge would have to be two days behind to miss.
- The build before the live one (`previous`) is kept however old it is.
- Cleanup never runs against a build younger than 48 hours, so a publish
  that failed part of the way, or a second publisher still writing, is not
  deleted by another publish.
- Two publishers at once: the second reads the pointer again after its wait
  and goes on top of the first. If it still writes a pointer that does not
  list the first one's build, that build is unlisted but young and stays.
- Beyond the guarantee (a pointer more than 48 hours stale) the answer is
  503. It is never a response assembled from two builds.

Limits that remain:

- It is one pointer over immutable keys, not a transaction across requests.
  While edge locations move to the new pointer, two requests (even from one
  page) can be answered from different builds. A client that needs one build
  for a page compares `x-nfl-build` across its responses and refetches.
- KV gives no hard bound on propagation. Nothing here depends on one: the
  whole-request fallback and the retention time are what readers rely on.
- Odds (`nfl:odds:latest`) are a separate single key written by the Worker.
  They join a build by `game_id` and `player_id`, so odds resolved against
  one build can be shown beside the next build for up to one refresh.
- D1 is written before KV and is not on the request path. After a failed
  publish D1 can be ahead of KV, or (if D1 itself failed part of the way)
  hold some slices of the new build: a slice's hash is recorded after its
  rows, so the next run rewrites any slice that did not finish. `nfl_builds`
  records that a build passed its checks and reached D1, not that it is the
  one being served; `nfl:current` is the authority on that.
- Rollout order: the Worker that reads the pointer is deployed before the
  first versioned publish. An older Worker keeps reading the unversioned
  keys, which the publish never touches.

### The source archive

A publish to the account always includes the source archive (`r2`); the
builder refuses a publish of D1 or KV without it, and there is no override.

- Each source file is uploaded to the private bucket `pwr-props-archive` at
  `nflverse/<season>/<build id>/<file>`, then read back from R2 and its
  SHA-256 compared with the one recorded at download.
- A file identical to the newest archived copy is not uploaded again, but
  that copy is read back and checked too; if it is missing or differs, the
  file is uploaded again.
- Then the manifest (source URL, retrieval time, upstream last-modified and
  ETag, SHA-256, bytes, rows, archive key per file) is uploaded beside the
  files and checked the same way.
- If any of that fails, the build stops before D1 and KV. Objects already
  uploaded stay in the private bucket; readers keep the build they had.
- `nfl_data_snapshots.archive_key` is filled only for verified objects, and
  `nfl:meta.archive` is `{ status: "archived", files, manifest_key, uploaded, reused }`.
- `--publish r2` alone archives and verifies, and writes nothing to D1 or KV.

## Odds refresh: switches, the lock, and measurement

The refresh runs after the MLB refresh in the same 10-minute cron and shares
the provider's per-minute allowance with it.

| Worker var | Default | Effect |
|---|---|---|
| `NFL_ODDS_ENABLED` | `"false"` | Anything but `"true"`: no request is sent to the provider and nothing is written |
| `NFL_ODDS_MAX_REQUESTS` | 9 | Requests one run may send |
| `NFL_ODDS_FANDUEL_GAMES` | 3 | FanDuel games per run (rotation) |
| `NFL_ODDS_MIN_INTERVAL_MINUTES` | 5 (never under 2) | No attempt may start this soon after another attempt started |
| `NFL_ODDS_FRESH_MINUTES`, `NFL_ODDS_STALE_MINUTES` | 15, 30 | Freshness thresholds |

### Paths to the provider

| Path | Sport | Gate |
|---|---|---|
| cron `*/10 * * * *` | MLB `refreshOdds`: up to 8 pages of `/odds`, plus `/markets` once when its cached market list is missing | none; throws on any failed response |
| `GET /debug/refresh-odds` | MLB `refreshOdds`, on demand | the `DEBUG_KEY` secret |
| cron `*/10 * * * *`, after MLB settles | NFL `refreshNflOdds` | `NFL_ODDS_ENABLED`, then the lock below |

Nothing else in the Worker calls the provider. NFL has no on-demand path.

### The lock

KV cannot provide mutual exclusion: two invocations that both read "nothing
is running" both go ahead. The lock is one conditional `INSERT` into D1
(`nfl_odds_runs`), made before the first provider request, that succeeds only
if no attempt started inside the minimum interval. D1 runs the statement
atomically, so of any invocations starting together exactly one proceeds.

- What is recorded, and when: an `attempt` row with the run's start time and
  outcome `started`, at the start. The same row is completed at the end.
- It is never released early. A run that fails or is killed still holds the
  interval, so a failing provider is not retried until the next tick.
- A run cannot outlast what it holds: each provider request times out after
  15 seconds, no request is started within a minute of the interval's end,
  and a provider failure of any kind ends the run.
- If D1 cannot be reached the run does not happen.
- It covers NFL against NFL. MLB has no lock and is not changed; MLB runs
  first in the tick, and NFL reads `x-ratelimit-remaining` on every response
  and stops at 1, and on a 429.

### What a run leaves in the ledger

| Row | Meaning |
|---|---|
| `attempt` / `success` | Every sweep it made was complete; odds stored |
| `attempt` / `partial` | Odds stored; at least one sweep was cut short (`reason` says which and why) |
| `attempt` / `failed` | Nothing was retrieved, or an error; nothing stored; stored odds and their times untouched |
| `attempt` / `started` | The run never finished (killed) |
| `skip` / `skipped` | No provider request: `too_soon`, `no_slate`, `no_pregame_games`, `snapshot_unavailable` |

`detail_json` holds the slate, the FanDuel games planned, and per sweep the
games retrieved completely with, per prop, the markets that had a main line
and the provider's newest timestamp. Rows older than 14 days are deleted.

### What a refresh does to stored odds

| Event | Stored prices for that book and game | `fetched_at` |
|---|---|---|
| Rows retrieved completely | Replaced by what was retrieved | Now |
| Complete sweep, no rows for the game | Removed (nothing is posted) | Now (the check is recorded, with 0 markets) |
| A market missing from a completely retrieved game (suspended, pulled) | That market removed | The game's other markets: now |
| Game cut off by a page or request limit, or not reached | Kept | Unchanged |
| A FanDuel game not in this run's rotation | Kept | Unchanged |
| Run fails or retrieves nothing | Kept; nothing is written at all | Unchanged, and `updated_at` too |

A kept price ages: after 30 minutes it is `stale` and is never a best price.

`scripts/nfl-odds-cadence.mjs` reads the ledger and reports attempts by
outcome, skips, the interval between completed retrievals per book and prop,
each book's slate coverage now and over the window, and the age of the last
stored refresh, from rows labeled `live` only. Stored odds and ledger rows
carry `source`: `"live"` when the rows came from the provider through the
real fetch, `"fixture"` for anything built from test data or a capture.

## Inspecting the data

```
node etl/nfl/build.mjs --season 2026                          # build to etl/nfl/out (no publish)
node scripts/nfl-inspect.mjs research "Terry McLaurin" rec_yds --summary
node scripts/nfl-inspect.mjs defense BAL
```
