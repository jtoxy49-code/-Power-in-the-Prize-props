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
| Odds | `src/nfl/props.js`, `src/nfl/odds-rules.js`, `src/nfl/odds.js` | Allowlist, main-line rule, freshness, paging with cursor recovery, KV write |
| API | `src/nfl/api.js`, `src/nfl/research.js` | `/api/nfl/*`, reading KV only |
| Frontend | `public/assets/js/nfl/` | Not started. No NFL UI exists. |

The builder (`etl/nfl/build.mjs`) runs outside the Worker. The Worker never
loads play-by-play and never writes D1.

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
`cache-control: private`. Errors are `{ "error": "..." }` with 400, 404 or 405.

### `/api/nfl/meta`
`{ sport, season, week, as_of_week, data_through_week, build_id, built_at, modules: { snap_counts, routes, coverage, weather, model }, module_notes, sources: [{ dataset, url, retrieved_at, source_last_modified, sha256, bytes, rows_total }], counts, checks: [{ name, ok, detail }], games_awaiting_stats, attribution }`

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
`{ sport, season, week, updated_at, freshness_rule: { fresh_minutes, stale_minutes }, games: { <game_id>: { event_id, kickoff_utc, books: { <sportsbook>: { fetched_at, markets } } } }, markets: [...], counts, runs }`

A market: `{ market_id, game_id, player_id, player_name, team_id, position, prop_type, market_type, exposed, books: [...], best }`.

A book entry: `{ sportsbook, fetched_at, seen_at, age_minutes, status, main: { line, over, under, over_implied, under_implied, hold, two_sided_lines } | null, ladder_count, provider_flagged_line }`.
`status` is `fresh` (15 minutes or less), `aging` (to 30) or `stale`.

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

| Key | Written by | Contents |
|---|---|---|
| `nfl:meta` | builder, last | Build stamp, source freshness, checks |
| `nfl:slate:current`, `nfl:slate:{season}:{week}` | builder | This week's games and environment |
| `nfl:rosters:current` | builder | Skill-position rosters, for resolving odds names |
| `nfl:team:{team_id}` (32) | builder | That team's player profiles, usage and game logs |
| `nfl:defense:{season}:{as_of_week}`, `nfl:defense:current` | builder | All 32 defensive profiles |
| `nfl:status:latest` | builder | Injuries and depth charts |
| `nfl:players:index` | builder | player_id to team |
| `nfl:odds:latest` | Worker cron | Current props per book with fetch times |
| `nfl:odds:unresolved` | Worker cron | Quarantined rows; never served |

## Inspecting the data

```
node etl/nfl/build.mjs --season 2026                          # build to etl/nfl/out (no publish)
node scripts/nfl-inspect.mjs research "Terry McLaurin" rec_yds --summary
node scripts/nfl-inspect.mjs defense BAL
```
