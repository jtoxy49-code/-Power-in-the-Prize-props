// SERVING PAYLOADS: the compact, current-week objects the Worker reads from KV.
// Built once per build so a page needs one or two reads, not ten raw queries.
// Pure: derived rows in, { key: object } out.
import { DEFENSE_METRICS, POSITION_METRICS, DVP_POSITIONS } from "../../src/nfl/metrics.js";
import { NFL_TEAMS } from "../../src/nfl/teams.js";
import { SKILL_POSITIONS } from "./derive.mjs";

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const groupBy = (rows, fn) => { const m = new Map(); for (const r of rows) { const k = fn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

const GAME_FIELDS = ["game_id", "season", "season_type", "week", "kickoff_utc", "home_team_id", "away_team_id", "location", "stadium", "roof", "surface", "home_rest", "away_rest", "status", "home_score", "away_score", "home_qb_id", "away_qb_id", "home_qb_name", "away_qb_name"];
const LOG_FIELDS = ["week", "game_id", "opponent_id", "is_home", "team_id", "played", "not_played_reason", "roster_status",
  "attempts", "completions", "passing_yards", "passing_tds", "interceptions", "sacks", "dropbacks", "deep_attempts", "scrambles",
  "carries", "rushing_yards", "rushing_tds", "runs_10plus", "rz_carries", "carry_share", "backfield_carry_share",
  "targets", "receptions", "receiving_yards", "receiving_tds", "receiving_air_yards", "receptions_20plus", "rz_targets", "target_share", "air_yards_share"];
const USAGE_DROP = ["season", "as_of_week", "player_id", "team_id", "position", "sample_window"];

/** The registry as the API serves it: labels and direction, no functions. */
export const metricRegistry = () => ({
  defense: DEFENSE_METRICS.map((m) => pick(m, ["key", "group", "label", "unit", "strong", "kind", "min_den"])),
  position: POSITION_METRICS.map((m) => pick(m, ["key", "label", "unit", "strong", "kind", "min_den", "only"])),
  positions: DVP_POSITIONS,
  rank_convention: "1 = strongest defense, 32 = weakest; percentile 100 = strongest",
});

/**
 * @param {object} d  everything the build derived (see build.mjs)
 * @returns {Record<string, object>} KV key -> value
 */
export function buildPayloads(d) {
  const { season, asOfWeek, buildId, builtAt } = d;
  const out = {};
  const week = asOfWeek;
  const stamp = { sport: "nfl", season, week, as_of_week: asOfWeek, data_through_week: asOfWeek - 1, build_id: buildId, built_at: builtAt };

  // ---- slate: this week's games with their environment
  const env = new Map(d.environment.map((e) => [e.game_id, e]));
  const weekGames = d.games.filter((g) => g.week === week);
  const slate = {
    ...stamp,
    games: weekGames.map((g) => {
      const e = env.get(g.game_id);
      return {
        ...pick(g, GAME_FIELDS),
        environment: {
          spread_line: g.spread_line, total_line: g.total_line, home_implied_total: g.home_implied_total, away_implied_total: g.away_implied_total,
          spread_convention: "positive = home team favored", lines_source: "nflverse:schedule",
          home: e ? { plays_pg: e.home_plays_pg, pass_rate: e.home_pass_rate, neutral_pass_rate: e.home_neutral_pass_rate, pass_rate_over_expected: e.home_proe } : null,
          away: e ? { plays_pg: e.away_plays_pg, pass_rate: e.away_pass_rate, neutral_pass_rate: e.away_neutral_pass_rate, pass_rate_over_expected: e.away_proe } : null,
          // No weather provider is connected. Nothing is estimated.
          weather: { status: g.roof === "dome" || g.roof === "closed" ? "indoors" : "not_configured", temperature_f: null, wind_mph: null, gust_mph: null, precip_probability: null, updated_at: null },
        },
      };
    }),
  };
  out[`nfl:slate:${season}:${week}`] = slate;
  out["nfl:slate:current"] = slate;

  // ---- rosters for name resolution (offensive skill players of this week)
  const currentRoster = d.rosters.filter((r) => r.week === d.rosterWeek && SKILL_POSITIONS.includes(r.position) && ["ACT", "INA", "RES"].includes(r.status));
  const rosterByTeam = groupBy(currentRoster, (r) => r.team_id);
  out["nfl:rosters:current"] = { ...stamp, roster_week: d.rosterWeek, teams: Object.fromEntries([...rosterByTeam].map(([t, list]) => [t, list.map((r) => pick(r, ["player_id", "display_name", "first_name", "last_name", "football_name", "position", "status"]))])) };

  // ---- status: injuries for this week and the depth chart
  const injuries = groupBy(d.injuries.filter((i) => i.week === week), (i) => i.team_id);
  const depth = groupBy(d.depthCharts, (r) => r.team_id);
  const injuryOf = new Map(d.injuries.filter((i) => i.week === week).map((i) => [i.player_id, i]));
  const depthOf = new Map();
  for (const r of d.depthCharts) if (!depthOf.has(r.player_id) || r.pos_rank < depthOf.get(r.player_id).pos_rank) depthOf.set(r.player_id, r);
  const INJ = ["player_id", "display_name", "position", "game_status", "practice_status", "report_primary_injury", "practice_primary_injury", "reported_at", "captured_date"];
  out["nfl:status:latest"] = {
    ...stamp, captured_date: d.capturedDate,
    note: "Official report via nflverse: latest status per player for the week. reported_at is null because the source carries no report time.",
    teams: Object.fromEntries(NFL_TEAMS.map((t) => [t.team_id, {
      injuries: (injuries.get(t.team_id) || []).map((i) => pick(i, INJ)),
      depth_chart_snapshot_at: depth.get(t.team_id)?.[0]?.snapshot_at ?? null,
      depth_chart: (depth.get(t.team_id) || []).map((r) => pick(r, ["player_id", "display_name", "pos_abb", "pos_slot", "pos_rank", "pos_group"])),
    }])),
  };

  // ---- defense: all 32 profiles entering this week
  const defByTeam = groupBy(d.defenseAsOf.rows, (r) => r.team_id);
  const posByTeam = groupBy(d.defenseAsOf.positionRows, (r) => r.team_id);
  const league = {}, leaguePos = {};
  for (const r of d.defenseAsOf.rows) league[r.metric_key] = r.league_avg;
  for (const r of d.defenseAsOf.positionRows) (leaguePos[r.position] ||= {})[r.metric_key] = r.league_avg;
  const M = ["value", "rank", "percentile", "sample", "small_sample"];
  out[`nfl:defense:${season}:${asOfWeek}`] = {
    ...stamp, registry: metricRegistry(), league, league_vs_position: leaguePos,
    teams: Object.fromEntries([...defByTeam].map(([team, rows]) => [team, {
      games: rows[0].games,
      opponents: d.defenseAsOf.opponents.get(team) || [],
      metrics: Object.fromEntries(rows.map((r) => [r.metric_key, pick(r, M)])),
      vs_position: Object.fromEntries(DVP_POSITIONS.map((pos) => [pos, Object.fromEntries((posByTeam.get(team) || []).filter((r) => r.position === pos).map((r) => [r.metric_key, pick(r, M)]))])),
    }])),
  };
  out["nfl:defense:current"] = { season, as_of_week: asOfWeek, key: `nfl:defense:${season}:${asOfWeek}` };

  // ---- one object per team: its skill players' profiles, usage and game logs
  const usage = groupBy(d.usage, (u) => u.player_id);
  const logs = groupBy(d.playerWeeks, (p) => p.player_id);
  const tendency = new Map(d.tendencies.map((t) => [t.team_id, t]));
  const playerDim = new Map(d.players.map((p) => [p.player_id, p]));
  const index = {};
  for (const t of NFL_TEAMS) {
    const roster = rosterByTeam.get(t.team_id) || [];
    const players = roster.map((r) => {
      const p = playerDim.get(r.player_id) || {};
      const u = Object.fromEntries((usage.get(r.player_id) || []).map((x) => [x.sample_window, Object.fromEntries(Object.entries(x).filter(([k]) => !USAGE_DROP.includes(k)))]));
      const inj = injuryOf.get(r.player_id);
      const dc = depthOf.get(r.player_id);
      index[r.player_id] = { team_id: t.team_id, position: r.position, display_name: r.display_name };
      return {
        player_id: r.player_id, display_name: r.display_name, position: r.position, team_id: t.team_id, jersey_number: r.jersey_number, roster_status: r.status,
        headshot_url: p.headshot_url ?? null, ids: pick(p, ["espn_id", "pfr_id", "sleeper_id", "sportradar_id", "pff_id"]),
        depth_chart: dc ? pick(dc, ["pos_abb", "pos_slot", "pos_rank"]) : null,
        injury: inj ? pick(inj, ["game_status", "practice_status", "report_primary_injury", "practice_primary_injury", "captured_date"]) : null,
        usage: { season: u.season || null, L5: u.L5 || null, L3: u.L3 || null },
        // every game week this season, oldest first; a week he did not play has played = 0 and null stats
        game_log: (logs.get(r.player_id) || []).sort((a, b) => a.week - b.week).map((g) => pick(g, LOG_FIELDS)),
      };
    });
    out[`nfl:team:${t.team_id}`] = { ...stamp, team: pick(t, ["team_id", "abbreviation", "display_name", "city", "nickname"]), tendencies: tendency.get(t.team_id) || null, players };
  }
  out["nfl:players:index"] = { ...stamp, players: index };

  // ---- meta, written last so readers switch builds only when one is complete
  out["nfl:meta"] = {
    ...stamp,
    modules: { snap_counts: false, routes: false, coverage: false, weather: false, model: false },
    module_notes: {
      snap_counts: "Off: commercial usage rights of the PFR-derived source are unclear.",
      routes: "Not available from open data in season.", coverage: "Not available from open data in season.",
      weather: "No licensed provider connected yet.", model: "Reserved interface only; no model exists.",
    },
    sources: d.snapshots.map((s) => pick(s, ["dataset", "season", "url", "retrieved_at", "source_last_modified", "sha256", "bytes", "rows_total"])),
    // where the consumed source files are: "archived" (R2), "pending" (held locally), "failed", or "not_published"
    archive: d.archive ?? { status: "not_published" },
    counts: d.counts, checks: d.checks,
    // finished in the schedule, stats not published by the source yet: in no game log or aggregate
    games_awaiting_stats: d.pendingGames || [],
    attribution: "Data: nflverse (CC-BY 4.0)",
  };
  return out;
}
