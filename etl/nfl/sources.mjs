// INGESTION: the nflverse datasets the builder reads, where they live, and the
// columns each must have. A dataset that is missing a required column fails
// the build for that dataset with its name; nothing is silently skipped.
//
// SNAP COUNTS ARE NOT HERE ON PURPOSE. They originate from Pro Football
// Reference and their commercial usage rights are unclear, so NFL V1 does not
// ingest them. A licensed source can be added as its own entry later.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decodeCsv, parseCsv } from "./csv.mjs";

const RELEASES = "https://github.com/nflverse/nflverse-data/releases/download";

export const DATASETS = {
  schedule: {
    url: () => `${RELEASES}/schedules/games.csv`,
    gzip: false, seasonal: false,
    required: ["game_id", "season", "game_type", "week", "gameday", "gametime", "away_team", "home_team", "away_score", "home_score", "location", "roof", "surface", "spread_line", "total_line", "away_rest", "home_rest", "stadium_id", "stadium"],
    columns: ["game_id", "season", "game_type", "week", "gameday", "weekday", "gametime", "away_team", "away_score", "home_team", "home_score", "location", "overtime", "old_game_id", "gsis", "pfr", "espn", "ftn", "away_rest", "home_rest", "away_moneyline", "home_moneyline", "spread_line", "away_spread_odds", "home_spread_odds", "total_line", "under_odds", "over_odds", "div_game", "roof", "surface", "temp", "wind", "away_qb_id", "home_qb_id", "away_qb_name", "home_qb_name", "stadium_id", "stadium"],
  },
  pbp: {
    url: (season) => `${RELEASES}/pbp/play_by_play_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["game_id", "week", "posteam", "defteam", "play_type", "qb_dropback", "yards_gained", "epa", "success", "receiver_player_id", "rusher_player_id", "passer_player_id"],
    columns: ["play_id", "game_id", "season_type", "week", "posteam", "defteam", "play_type", "qb_dropback", "qb_scramble", "qb_kneel", "qb_spike", "pass_attempt", "sack", "complete_pass", "interception", "yards_gained", "air_yards", "yards_after_catch", "epa", "success", "first_down", "pass_touchdown", "rush_touchdown", "two_point_attempt", "yardline_100", "down", "ydstogo", "wp", "half_seconds_remaining", "pass_oe", "qb_hit", "passer_player_id", "rusher_player_id", "receiver_player_id"],
  },
  stats_player_week: {
    url: (season) => `${RELEASES}/stats_player/stats_player_week_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["player_id", "position", "season", "week", "team", "opponent_team", "attempts", "carries", "targets", "receptions", "receiving_yards", "rushing_yards", "passing_yards"],
    columns: ["player_id", "player_display_name", "position", "position_group", "season", "week", "season_type", "game_id", "team", "opponent_team", "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "passing_air_yards", "passing_yards_after_catch", "passing_first_downs", "passing_epa", "passing_cpoe", "carries", "rushing_yards", "rushing_tds", "rushing_first_downs", "rushing_epa", "receptions", "targets", "receiving_yards", "receiving_tds", "receiving_air_yards", "receiving_yards_after_catch", "receiving_first_downs", "receiving_epa", "target_share", "air_yards_share", "wopr"],
  },
  stats_team_week: {
    url: (season) => `${RELEASES}/stats_team/stats_team_week_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["season", "week", "team", "opponent_team", "attempts", "carries", "passing_yards", "rushing_yards"],
    columns: ["season", "week", "team", "season_type", "game_id", "opponent_team", "completions", "attempts", "passing_yards", "passing_tds", "passing_interceptions", "sacks_suffered", "carries", "rushing_yards", "rushing_tds", "targets", "receptions", "receiving_air_yards"],
  },
  roster_weekly: {
    url: (season) => `${RELEASES}/weekly_rosters/roster_weekly_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["season", "team", "position", "status", "full_name", "gsis_id", "week"],
    columns: ["season", "team", "position", "depth_chart_position", "jersey_number", "status", "full_name", "first_name", "last_name", "football_name", "birth_date", "gsis_id", "espn_id", "sportradar_id", "pfr_id", "pff_id", "sleeper_id", "headshot_url", "week", "game_type", "status_description_abbr", "years_exp"],
  },
  injuries: {
    url: (season) => `${RELEASES}/injuries/injuries_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["season", "team", "week", "gsis_id", "report_status", "practice_status"],
    columns: ["season", "season_type", "game_type", "team", "week", "gsis_id", "position", "full_name", "report_primary_injury", "report_secondary_injury", "report_status", "practice_primary_injury", "practice_secondary_injury", "practice_status", "date_modified"],
  },
  depth_charts: {
    url: (season) => `${RELEASES}/depth_charts/depth_charts_${season}.csv.gz`,
    gzip: true, seasonal: true,
    required: ["dt", "team", "gsis_id", "pos_abb", "pos_rank"],
    columns: ["dt", "team", "player_name", "espn_id", "gsis_id", "pos_grp", "pos_name", "pos_abb", "pos_slot", "pos_rank"],
  },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileName = (name, season, gzip) => `${name}${season ? `_${season}` : ""}.csv${gzip ? ".gz" : ""}`;

/**
 * Fetches one dataset's raw bytes and returns them with the provenance the
 * archive needs. With `offline`, the bytes come from the cache directory and
 * the recorded metadata from the earlier download is reused.
 */
export async function fetchDataset(name, season, { cacheDir, offline = false, fetchImpl = fetch } = {}) {
  const ds = DATASETS[name];
  if (!ds) throw new Error(`unknown dataset: ${name}`);
  const url = ds.url(season);
  const file = fileName(name, ds.seasonal ? season : null, ds.gzip);
  const cached = cacheDir ? join(cacheDir, file) : null;
  const metaPath = cached ? `${cached}.meta.json` : null;

  if (offline) {
    if (!cached || !existsSync(cached)) throw new Error(`offline build: ${file} is not in the cache`);
    const bytes = readFileSync(cached);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    return { name, season: ds.seasonal ? season : null, url, file, bytes, gzip: ds.gzip, sha256: sha256(bytes), size: bytes.length, retrieved_at: meta.retrieved_at || null, last_modified: meta.last_modified || null, etag: meta.etag || null, from_cache: true };
  }

  const res = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "pwr-props-nfl-builder" } });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const meta = {
    retrieved_at: new Date().toISOString(),
    last_modified: res.headers.get("last-modified") ? new Date(res.headers.get("last-modified")).toISOString() : null,
    etag: res.headers.get("etag"),
  };
  if (cached) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, bytes);
    writeFileSync(metaPath, JSON.stringify(meta));
  }
  return { name, season: ds.seasonal ? season : null, url, file, bytes, gzip: ds.gzip, sha256: sha256(bytes), size: bytes.length, ...meta, from_cache: false };
}

/** Parses a fetched dataset, checking its required columns. */
export function readDataset(snapshot, { filter } = {}) {
  const ds = DATASETS[snapshot.name];
  try {
    const out = parseCsv(decodeCsv(snapshot.bytes, { gzip: snapshot.gzip }), { columns: ds.columns, required: ds.required, filter });
    snapshot.rows_total = out.total;
    return out.rows;
  } catch (err) {
    throw new Error(`${snapshot.name}${snapshot.season ? ` ${snapshot.season}` : ""}: ${err.message}`);
  }
}
