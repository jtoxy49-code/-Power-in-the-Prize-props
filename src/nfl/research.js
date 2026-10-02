// NFL API: the one coherent research payload for a player and a prop.
// Pure: the already-built KV objects in, one object out. It joins; it does not
// compute football. Every number here was derived by the builder.
//
// Phase 1 scope: data only. There is no matchup classification, no findings
// text and no projection in this payload. `model` is always null.
import { PROPS, emptyModel, weatherFor } from "./props.js";
import { bestPrices, freshness, FRESHNESS } from "./odds-rules.js";

// Which defensive metrics each V1 prop reads, in three tiers. "POS:" means
// the defense-vs-position table for the player's position group. Phase 1 lists
// them; it does not blend them.
export const PROP_METRICS = {
  pass_yds: {
    primary: ["pass_epa_per_dropback", "dropback_success_rate", "net_ypa_allowed", "explosive_pass_rate"],
    secondary: ["pass_yards_per_game", "sack_rate", "qb_hit_rate", "completion_pct_allowed"],
    context: ["pass_att_per_game", "ypa_allowed", "adot_allowed", "yac_per_reception_allowed", "pass_td_rate", "int_rate", "completions_20plus_per_game"],
  },
  rush_yds: {
    primary: ["rush_epa_per_play", "rush_success_rate", "POS:ypc", "explosive_run_rate", "stuff_rate"],
    secondary: ["POS:rush_yards_per_game", "rush_first_down_rate"],
    context: ["POS:carries_per_game", "rush_att_per_game", "ypc_allowed", "rush_yards_per_game", "runs_10plus_per_game", "runs_20plus_per_game", "rush_tds_per_game"],
  },
  rec_yds: {
    primary: ["POS:yards_per_target", "POS:rec_yards_per_game", "explosive_pass_rate", "pass_epa_per_dropback"],
    secondary: ["yac_per_reception_allowed", "net_ypa_allowed"],
    context: ["POS:targets_per_game", "POS:target_share", "POS:yards_per_reception", "adot_allowed", "sack_rate"],
  },
  receptions: {
    primary: ["POS:receptions_per_game", "POS:catch_rate", "short_completion_pct_allowed"],
    secondary: ["completion_pct_allowed", "dropback_success_rate"],
    context: ["POS:targets_per_game", "POS:target_share", "pass_att_per_game"],
  },
};

export const defaultProp = (position) => (position === "QB" ? "pass_yds" : position === "RB" || position === "FB" ? "rush_yds" : "rec_yds");
const dvpGroup = (position) => (position === "FB" ? "RB" : ["RB", "WR", "TE"].includes(position) ? position : null);

const median = (v) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * A stat's results against a line over a set of games.
 * A game he did not play, or one with no recorded value, is left out of n and
 * named in `not_counted`; it is never treated as a 0. A value equal to the
 * line is a push: it is neither an Over nor an Under and is excluded from the
 * hit-rate denominator.
 */
export function againstLine(games, stat, line) {
  const values = [];
  let notCounted = 0;
  for (const g of games) {
    const v = g.played ? g[stat] : null;
    if (v == null) { notCounted++; continue; }
    values.push(Number(v));
  }
  const out = { games: values.length, not_counted: notCounted, mean: values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : null, median: median(values), values };
  if (line == null) return { ...out, line: null, over: null, under: null, push: null, over_rate: null };
  const over = values.filter((v) => v > line).length, under = values.filter((v) => v < line).length, push = values.length - over - under;
  return { ...out, line, over, under, push, over_rate: over + under ? Number((over / (over + under)).toFixed(4)) : null };
}

function metricRows(keys, tier, defense, team, group) {
  const t = defense.teams?.[team];
  const reg = new Map([...(defense.registry?.defense || []).map((m) => [m.key, m]), ...(defense.registry?.position || []).map((m) => [`POS:${m.key}`, m])]);
  const n = Object.keys(defense.teams || {}).length;
  return keys.map((k) => {
    const isPos = k.startsWith("POS:");
    const key = isPos ? k.slice(4) : k;
    const cell = isPos ? t?.vs_position?.[group]?.[key] : t?.metrics?.[key];
    const def = reg.get(k) || {};
    return {
      metric_key: key, scope: isPos ? `vs_${group}` : "team", tier, label: def.label ?? key, unit: def.unit ?? null, strong: def.strong ?? null, kind: def.kind ?? null,
      value: cell?.value ?? null, rank: cell?.rank ?? null, of: n, percentile: cell?.percentile ?? null,
      league_avg: (isPos ? defense.league_vs_position?.[group]?.[key] : defense.league?.[key]) ?? null,
      sample: cell?.sample ?? null, small_sample: cell ? !!cell.small_sample : true,
    };
  });
}

/**
 * @param {object} a
 * @param {string} a.playerId
 * @param {string} [a.propType]
 * @param {object} a.team      nfl:team:{team_id}
 * @param {object} a.slate     nfl:slate:current
 * @param {object} a.defense   nfl:defense:{season}:{as_of_week}
 * @param {object} a.status    nfl:status:latest
 * @param {object|null} a.odds nfl:odds:latest
 * @param {number} a.now
 */
export function buildResearch({ playerId, propType, team, slate, defense, status, odds, now, cfg = FRESHNESS }) {
  const player = team?.players?.find((p) => p.player_id === playerId);
  if (!player) return null;
  const prop = PROPS[propType || defaultProp(player.position)];
  if (!prop) return { error: "unknown_prop" };
  const group = dvpGroup(player.position);
  const game = slate?.games?.find((g) => g.home_team_id === player.team_id || g.away_team_id === player.team_id) || null;
  const isHome = game ? game.home_team_id === player.team_id : null;
  const opponent = game ? (isHome ? game.away_team_id : game.home_team_id) : null;
  const env = game?.environment || null;

  // ---- odds: each book's own line, with its age; best price only on a shared number
  const market = odds?.markets?.find((m) => m.player_id === playerId && m.prop_type === prop.prop_type) || null;
  const books = (market?.books || []).map((b) => ({ ...b, ...freshness(b.fetched_at, now, cfg) }));
  const usable = books.filter((b) => b.main && b.status !== "stale");
  const defaultBook = usable.find((b) => b.sportsbook === "draftkings") || usable[0] || books.find((b) => b.main) || null;
  const line = defaultBook?.main?.line ?? null;

  const log = player.game_log || [];
  const playedLog = log.filter((g) => g.played);
  const samples = { season: againstLine(log, prop.stat, line), L5: againstLine(playedLog.slice(-5), prop.stat, line), L10: againstLine(playedLog.slice(-10), prop.stat, line), H2H: againstLine(log.filter((g) => g.opponent_id === opponent), prop.stat, line) };

  // ---- matchup: the opposing defense on this prop's metrics
  const tiers = PROP_METRICS[prop.prop_type];
  const matchup = opponent && defense ? {
    opponent_id: opponent, as_of_week: defense.as_of_week, games: defense.teams?.[opponent]?.games ?? 0,
    opponents_faced: defense.teams?.[opponent]?.opponents ?? [],
    rank_convention: "1 = strongest defense, 32 = weakest",
    metrics: [...metricRows(tiers.primary, "primary", defense, opponent, group), ...metricRows(tiers.secondary, "secondary", defense, opponent, group), ...metricRows(tiers.context, "context", defense, opponent, group)],
    classification: null, // Phase 1 lists the metrics; the matchup band is a later phase
  } : null;

  // ---- personnel: statuses only, no impact estimate
  const share = (p) => p.usage?.L5 || p.usage?.season || {};
  const room = (team.players || []).filter((p) => p.player_id !== playerId && (dvpGroup(p.position) === group || p.position === "QB" || (player.position === "QB" && ["WR", "TE", "RB"].includes(p.position))) && (p.usage?.season || p.injury));
  const teammates = room.map((p) => ({ player_id: p.player_id, display_name: p.display_name, position: p.position, roster_status: p.roster_status, injury: p.injury, target_share: share(p).target_share ?? null, carry_share: share(p).carry_share ?? null, games: share(p).games ?? 0 }))
    .sort((a, b) => (b.target_share ?? 0) + (b.carry_share ?? 0) - ((a.target_share ?? 0) + (a.carry_share ?? 0)));
  const teamStatus = status?.teams?.[player.team_id] || { injuries: [], depth_chart: [] };
  const oppStatus = opponent ? status?.teams?.[opponent] || { injuries: [], depth_chart: [] } : { injuries: [], depth_chart: [] };
  const injOf = new Map(teamStatus.injuries.map((i) => [i.player_id, i]));
  const OL = ["LT", "LG", "C", "RG", "RT"];
  const line5 = OL.map((pos) => { const s = teamStatus.depth_chart.find((d) => d.pos_abb === pos && d.pos_rank === 1); return s ? { pos, player_id: s.player_id, display_name: s.display_name, game_status: injOf.get(s.player_id)?.game_status ?? null, practice_status: injOf.get(s.player_id)?.practice_status ?? null } : { pos, player_id: null, display_name: null, game_status: null, practice_status: null }; });
  const oppStarters = new Set(oppStatus.depth_chart.filter((d) => d.pos_rank === 1).map((d) => d.player_id));
  const OFFENSE = new Set(["QB", "RB", "FB", "WR", "TE", "T", "G", "C", "OL", "OT", "OG", "K", "P", "LS"]);
  const defenseOut = oppStatus.injuries.filter((i) => ["OUT", "DOUBTFUL"].includes(i.game_status) && !OFFENSE.has(i.position)).map((i) => ({ player_id: i.player_id, display_name: i.display_name, position: i.position, game_status: i.game_status, listed_starter: oppStarters.has(i.player_id) }));

  return {
    sport: "nfl", season: slate?.season ?? team.season, week: slate?.week ?? team.week, as_of_week: team.as_of_week, data_through_week: team.data_through_week, build_id: team.build_id,
    player: { player_id: player.player_id, display_name: player.display_name, position: player.position, team_id: player.team_id, jersey_number: player.jersey_number, headshot_url: player.headshot_url, roster_status: player.roster_status, depth_chart: player.depth_chart, ids: player.ids },
    prop: { prop_type: prop.prop_type, label: prop.label, stat: prop.stat, market_type: prop.market_type, exposed_in_v1: prop.exposed.includes(player.position) },
    game: game ? {
      game_id: game.game_id, kickoff_utc: game.kickoff_utc, opponent_id: opponent, is_home: game.location === "neutral" ? null : isHome, location: game.location,
      stadium: game.stadium, roof: game.roof, surface: game.surface, status: game.status, team_rest_days: isHome ? game.home_rest : game.away_rest, opponent_rest_days: isHome ? game.away_rest : game.home_rest,
      starting_qb: { team: isHome ? game.home_qb_name : game.away_qb_name, opponent: isHome ? game.away_qb_name : game.home_qb_name },
    } : null,
    environment: env ? {
      spread_line_home: env.spread_line, team_spread: env.spread_line == null ? null : isHome ? -env.spread_line : env.spread_line,
      team_spread_note: "negative = this player's team is favored",
      total_line: env.total_line, team_implied_total: isHome ? env.home_implied_total : env.away_implied_total, opponent_implied_total: isHome ? env.away_implied_total : env.home_implied_total,
      lines_source: env.lines_source, team_tendencies: team.tendencies, weather: weatherFor(game),
    } : null,
    odds: market ? {
      market_id: market.market_id, books, best: bestPrices({ books }, now, cfg), default_line: line == null ? null : { line, sportsbook: defaultBook.sportsbook },
      note: "Each book's own main line. Prices are compared only where books post the same number. A stale book is never 'best'.",
    } : null,
    samples,
    sample_note: "Current season only in Phase 1. A game not played is left out, never counted as 0. Pushes are excluded from over_rate.",
    usage: player.usage,
    game_log: log,
    matchup,
    personnel: { player_injury: player.injury, teammates, offensive_line: { listed_starters: line5, available: line5.filter((p) => p.player_id && !["OUT", "DOUBTFUL"].includes(p.game_status)).length, of: 5, basis: "depth chart and injury report (no snap data)" }, opponent_defense_out: defenseOut },
    modules: { snap_counts: false, routes: false, coverage: false, weather: false },
    model: emptyModel(),
  };
}
