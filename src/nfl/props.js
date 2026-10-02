// NFL prop families and the provider-market allowlist.
//
// NFL V1 is LOCKED to four props. Everything else the provider offers is
// listed under FUTURE_MARKETS for reference and is neither requested nor
// stored in V1.
//
// One provider market can carry several PWR props: `player_receiving_yards`
// holds wide receivers, tight ends and running backs. The matched player's
// position decides. `positions` are the positions a row may legitimately have
// (anything else is quarantined as a bad match); `exposed` are the positions
// V1 shows. A row that is allowed but not exposed (a QB's rushing yards, a
// running back's receptions) is stored with exposed = false for V1.5.

export const PROPS = {
  pass_yds: { prop_type: "pass_yds", market_type: "player_passing_yards", label: "Passing yards", short: "Pass Yds", stat: "passing_yards", positions: ["QB"], exposed: ["QB"], line_floor: 49.5, line_ceiling: 499.5 },
  rush_yds: { prop_type: "rush_yds", market_type: "player_rushing_yards", label: "Rushing yards", short: "Rush Yds", stat: "rushing_yards", positions: ["RB", "FB", "QB", "WR", "TE"], exposed: ["RB", "FB"], line_floor: 0.5, line_ceiling: 249.5 },
  rec_yds: { prop_type: "rec_yds", market_type: "player_receiving_yards", label: "Receiving yards", short: "Rec Yds", stat: "receiving_yards", positions: ["WR", "TE", "RB", "FB"], exposed: ["WR", "TE"], line_floor: 0.5, line_ceiling: 249.5 },
  receptions: { prop_type: "receptions", market_type: "player_receptions", label: "Receptions", short: "Rec", stat: "receptions", positions: ["WR", "TE", "RB", "FB"], exposed: ["WR", "TE"], line_floor: 0.5, line_ceiling: 19.5 },
};
// The floors and ceilings are sanity bounds for a MAIN line, not judgments:
// a main line outside them is quarantined with its raw rows for review.
// (Heuristic values, chosen wide; FanDuel's ladder rungs are not checked
// against them.)

export const V1_MARKET_TYPES = Object.values(PROPS).map((p) => p.market_type);
export const PROP_BY_MARKET = Object.fromEntries(Object.values(PROPS).map((p) => [p.market_type, p]));

// Verified present on the current plan by the 2026-10-02 probe; V1.5 and later.
export const FUTURE_MARKETS = {
  player_passing_attempts: "pass_att", player_passing_completions: "pass_cmp", player_rushing_attempts: "rush_att",
  "player_rushing_+_receiving_yards": "rush_rec_yds", "player_passing_+_rushing_yards": "pass_rush_yds",
  player_passing_touchdowns: "pass_tds", player_interceptions: "ints", player_longest_reception: "longest_rec", player_longest_rush: "longest_rush",
};

/** market_id: one player, one prop, one game. Deterministic; no lookup needed. */
export const marketId = (gameId, playerId, propType) => `nfl:${gameId}:${playerId}:${propType}`;

// The optional model fields a future, separately validated system may supply.
// Nothing in NFL Props computes them. Every payload carries `model: null`
// until that system exists, and every consumer must work when it is null.
export const MODEL_FIELDS = ["projected_mean", "projected_median", "lower_interval", "upper_interval", "prob_over", "prob_under", "confidence", "model_version", "generated_at"];
export const emptyModel = () => null;

// Weather: the interface only. No provider is connected and no value is
// produced until the approved commercial account exists.
export const WEATHER_FIELDS = ["temperature_f", "wind_mph", "gust_mph", "precip_probability", "precip_in", "roof", "updated_at"];
export const weatherFor = (game) => ({
  status: game?.roof === "dome" || game?.roof === "closed" ? "indoors" : "not_configured",
  roof: game?.roof ?? null, temperature_f: null, wind_mph: null, gust_mph: null, precip_probability: null, precip_in: null, updated_at: null,
});
