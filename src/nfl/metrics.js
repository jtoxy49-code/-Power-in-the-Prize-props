// DERIVED METRICS: the registry of NFL V1 defensive metrics, and the ranking
// rule. One definition serves the builder, the API labels and the tests.
//
// Every metric is a ratio of two sums over the defense's games, so a team value
// and the league value are computed the same way:
//   team   = sum(num) / sum(den)   over that defense's games
//   league = sum(num) / sum(den)   over every defense's games
// For a per-game metric the denominator is games, so the league value is the
// mean per team-game.
//
// RANK CONVENTION: 1 = strongest defense, 32 = weakest.
// `strong` says which direction is strong for the defense:
//   "low"  fewer or lower is stronger (yards allowed)
//   "high" more is stronger (stuff rate, sack rate, interception rate)
// `kind` separates quality from volume. A "volume" metric (attempts faced)
// reflects game script as much as defense: it is stored, ranked and shown, but
// is never part of a matchup composite.
//
// Pressure and blitz rates are absent on purpose: the open sources for them
// are PFR-derived or CC-BY-SA charting, neither approved for V1.

const g = (f) => (x) => x[f] ?? 0;

export const DEFENSE_METRICS = [
  // ---- run defense (designed runs only: scrambles and kneels excluded)
  { key: "rush_epa_per_play", group: "run", label: "Rush EPA per play allowed", unit: "epa", strong: "low", kind: "quality", num: g("rush_epa"), den: g("rush_att"), min_den: 30 },
  { key: "rush_success_rate", group: "run", label: "Rush success rate allowed", unit: "pct", strong: "low", kind: "quality", num: g("rush_success"), den: g("rush_att"), min_den: 30 },
  { key: "ypc_allowed", group: "run", label: "Yards per carry allowed", unit: "yards", strong: "low", kind: "quality", num: g("rush_yds"), den: g("rush_att"), min_den: 30 },
  { key: "rush_yards_per_game", group: "run", label: "Rushing yards allowed per game", unit: "yards", strong: "low", kind: "quality", num: g("rush_yds"), den: g("games") },
  { key: "rush_att_per_game", group: "run", label: "Rush attempts faced per game", unit: "count", strong: "low", kind: "volume", num: g("rush_att"), den: g("games") },
  { key: "explosive_run_rate", group: "run", label: "Explosive run rate allowed (10+ yards)", unit: "pct", strong: "low", kind: "quality", num: g("rush_10"), den: g("rush_att"), min_den: 30 },
  { key: "runs_10plus_per_game", group: "run", label: "10+ yard runs allowed per game", unit: "count", strong: "low", kind: "quality", num: g("rush_10"), den: g("games") },
  { key: "runs_20plus_per_game", group: "run", label: "20+ yard runs allowed per game", unit: "count", strong: "low", kind: "quality", num: g("rush_20"), den: g("games") },
  { key: "stuff_rate", group: "run", label: "Stuff rate (runs for 0 or fewer yards)", unit: "pct", strong: "high", kind: "quality", num: g("rush_stuffed"), den: g("rush_att"), min_den: 30 },
  { key: "rush_first_down_rate", group: "run", label: "Rush first-down rate allowed", unit: "pct", strong: "low", kind: "quality", num: g("rush_fd"), den: g("rush_att"), min_den: 30 },
  { key: "rush_tds_per_game", group: "run", label: "Rushing TDs allowed per game", unit: "count", strong: "low", kind: "quality", num: g("rush_td"), den: g("games") },

  // ---- pass defense (dropbacks = attempts + sacks + scrambles)
  { key: "pass_epa_per_dropback", group: "pass", label: "Pass EPA per dropback allowed", unit: "epa", strong: "low", kind: "quality", num: g("db_epa"), den: g("dropbacks"), min_den: 30 },
  { key: "dropback_success_rate", group: "pass", label: "Dropback success rate allowed", unit: "pct", strong: "low", kind: "quality", num: g("db_success"), den: g("dropbacks"), min_den: 30 },
  { key: "pass_yards_per_game", group: "pass", label: "Passing yards allowed per game", unit: "yards", strong: "low", kind: "quality", num: g("pass_yds"), den: g("games") },
  { key: "ypa_allowed", group: "pass", label: "Yards per attempt allowed", unit: "yards", strong: "low", kind: "quality", num: g("pass_yds"), den: g("pass_att"), min_den: 30 },
  { key: "net_ypa_allowed", group: "pass", label: "Net yards per attempt allowed", unit: "yards", strong: "low", kind: "quality", num: (x) => (x.pass_yds ?? 0) - (x.sack_yds ?? 0), den: (x) => (x.pass_att ?? 0) + (x.sacks ?? 0), min_den: 30 },
  { key: "completion_pct_allowed", group: "pass", label: "Completion % allowed", unit: "pct", strong: "low", kind: "quality", num: g("completions"), den: g("pass_att"), min_den: 30 },
  { key: "pass_td_rate", group: "pass", label: "Passing TD rate allowed", unit: "pct", strong: "low", kind: "quality", num: g("pass_td"), den: g("pass_att"), min_den: 30 },
  { key: "int_rate", group: "pass", label: "Interception rate", unit: "pct", strong: "high", kind: "quality", num: g("ints"), den: g("pass_att"), min_den: 30 },
  { key: "explosive_pass_rate", group: "pass", label: "Explosive pass rate allowed (20+ yard completions per attempt)", unit: "pct", strong: "low", kind: "quality", num: g("pass_20"), den: g("pass_att"), min_den: 30 },
  { key: "completions_20plus_per_game", group: "pass", label: "20+ yard completions allowed per game", unit: "count", strong: "low", kind: "quality", num: g("pass_20"), den: g("games") },
  { key: "sack_rate", group: "pass", label: "Sack rate", unit: "pct", strong: "high", kind: "quality", num: g("sacks"), den: g("dropbacks"), min_den: 30 },
  { key: "qb_hit_rate", group: "pass", label: "QB hit rate", unit: "pct", strong: "high", kind: "quality", num: g("qb_hits"), den: g("dropbacks"), min_den: 30 },
  { key: "short_completion_pct_allowed", group: "pass", label: "Completion % allowed under 10 air yards", unit: "pct", strong: "low", kind: "quality", num: g("short_cmp"), den: g("short_att"), min_den: 30 },
  { key: "yac_per_reception_allowed", group: "pass", label: "Yards after catch per reception allowed", unit: "yards", strong: "low", kind: "quality", num: g("yac"), den: g("completions"), min_den: 30 },
  { key: "adot_allowed", group: "pass", label: "Average depth of target faced", unit: "yards", strong: "low", kind: "volume", num: g("air_yds"), den: g("air_att"), min_den: 30 },
  { key: "pass_att_per_game", group: "pass", label: "Pass attempts faced per game", unit: "count", strong: "low", kind: "volume", num: g("pass_att"), den: g("games") },
];

// Defense versus position. `pos` is filled in per position (RB, WR, TE); the
// sums are the per-position columns of the defense-game facts.
const p = (f) => (x) => x[f] ?? 0;
export const POSITION_METRICS = [
  { key: "targets_per_game", label: "Targets faced per game", unit: "count", strong: "low", kind: "volume", num: p("tgt"), den: p("games") },
  { key: "receptions_per_game", label: "Receptions allowed per game", unit: "count", strong: "low", kind: "quality", num: p("rec"), den: p("games") },
  { key: "rec_yards_per_game", label: "Receiving yards allowed per game", unit: "yards", strong: "low", kind: "quality", num: p("rec_yds"), den: p("games") },
  { key: "yards_per_target", label: "Yards per target allowed", unit: "yards", strong: "low", kind: "quality", num: p("rec_yds"), den: p("tgt"), min_den: 40 },
  { key: "yards_per_reception", label: "Yards per reception allowed", unit: "yards", strong: "low", kind: "quality", num: p("rec_yds"), den: p("rec"), min_den: 25 },
  { key: "catch_rate", label: "Catch rate allowed", unit: "pct", strong: "low", kind: "quality", num: p("rec"), den: p("tgt"), min_den: 40 },
  { key: "rec_tds_per_game", label: "Receiving TDs allowed per game", unit: "count", strong: "low", kind: "quality", num: p("rec_td"), den: p("games") },
  { key: "target_share", label: "Share of opponent targets to the position", unit: "pct", strong: "low", kind: "volume", num: p("tgt"), den: p("team_tgt"), min_den: 40 },
  // RB only
  { key: "carries_per_game", label: "RB carries faced per game", unit: "count", strong: "low", kind: "volume", num: p("car"), den: p("games"), only: ["RB"] },
  { key: "rush_yards_per_game", label: "RB rushing yards allowed per game", unit: "yards", strong: "low", kind: "quality", num: p("rush_yds"), den: p("games"), only: ["RB"] },
  { key: "ypc", label: "RB yards per carry allowed", unit: "yards", strong: "low", kind: "quality", num: p("rush_yds"), den: p("car"), min_den: 50, only: ["RB"] },
  { key: "rush_tds_per_game", label: "RB rushing TDs allowed per game", unit: "count", strong: "low", kind: "quality", num: p("rush_td"), den: p("games"), only: ["RB"] },
];
export const DVP_POSITIONS = ["RB", "WR", "TE"];

const round = (v, d = 6) => (v == null ? null : Number(v.toFixed(d)));

/**
 * Values, league value, rank and percentile for one metric across teams.
 * @param {object} metric  a registry entry
 * @param {Map<string, object>} sumsByTeam  team_id -> summed facts
 * @returns {{league_avg:number|null, teams:Map<string, {value, rank, percentile, sample, small_sample}>}}
 *
 * rank: 1 = strongest. Equal values share the better rank (1, 2, 2, 4).
 * percentile: strength percentile, 100 for the strongest defense and 0 for the
 *   weakest: 100 * (N - rank) / (N - 1) over the N ranked teams.
 * A team with a zero denominator has value null and no rank.
 * small_sample: the denominator is under the metric's minimum; the value and
 *   rank are still stored, flagged, so the page can mute them.
 */
export function rankMetric(metric, sumsByTeam) {
  let leagueNum = 0, leagueDen = 0;
  const rows = [];
  for (const [team, sums] of sumsByTeam) {
    const num = metric.num(sums), den = metric.den(sums);
    leagueNum += num; leagueDen += den;
    rows.push({ team, value: den > 0 ? num / den : null, sample: den });
  }
  const ranked = rows.filter((r) => r.value != null).sort((a, b) => (metric.strong === "high" ? b.value - a.value : a.value - b.value));
  const n = ranked.length;
  const teams = new Map();
  let prev = null, prevRank = 0;
  ranked.forEach((r, i) => {
    const rank = prev != null && r.value === prev ? prevRank : i + 1;
    prev = r.value; prevRank = rank;
    teams.set(r.team, { value: round(r.value), rank, percentile: n > 1 ? round((100 * (n - rank)) / (n - 1), 1) : null, sample: r.sample, small_sample: metric.min_den ? r.sample < metric.min_den : false });
  });
  for (const r of rows) if (r.value == null) teams.set(r.team, { value: null, rank: null, percentile: null, sample: r.sample, small_sample: true });
  return { league_avg: leagueDen > 0 ? round(leagueNum / leagueDen) : null, teams };
}
