// NFL API: every /api/nfl/* route. Mounted from src/index.js AFTER the session
// and Premium gates, so these routes inherit the product's auth and add none
// of their own. They only read the KV objects the builder and the odds refresh
// wrote; nothing here computes football or calls an outside service. Builder
// payloads are read through one snapshot per request (see snapshot.js), so a
// response never mixes two builds.
//
//   GET /api/nfl/meta                       build stamp, source freshness, module flags
//   GET /api/nfl/teams                      the canonical team table
//   GET /api/nfl/slate                      this week's games with environment
//   GET /api/nfl/odds[?game=&player=]       current props, each book with its age (add ladders=1 for alternate rungs)
//   GET /api/nfl/player?id=                 profile, usage windows, game log
//   GET /api/nfl/gamelog?id=                the game log alone
//   GET /api/nfl/defense?team=              one defense: metrics, ranks, vs position
//   GET /api/nfl/injuries[?team=]           injury report and depth chart
//   GET /api/nfl/research?player=[&prop=]   the full research payload for a player and prop
import { NFL_TEAMS, isTeamId } from "./teams.js";
import { PROPS } from "./props.js";
import { ODDS_KEY, oddsConfig } from "./odds.js";
import { bestPrices, freshness, isPregame, slateCoverage } from "./odds-rules.js";
import { buildResearch } from "./research.js";
import { withSnapshot, SnapshotUnavailable } from "./snapshot.js";

const json = (body, status = 200, maxAge = 60) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": status === 200 ? `private, max-age=${maxAge}` : "no-store" } });
const bad = (message) => json({ error: message }, 400);
const missing = (message) => json({ error: message }, 404);
const kv = (env, key) => env.PROPS_DATA.get(key, "json");
const PLAYER_ID = /^\d{2}-\d{7}$/;

async function currentDefense(snap) {
  const ptr = await snap.get("nfl:defense:current");
  return ptr ? snap.get(ptr.key) : null;
}

/**
 * A book entry as served: its age and freshness status always; its ladder
 * (FanDuel's over-only alternate rungs) only when the caller asks for it.
 */
export function serveBook(b, now, cfg, ladders) {
  const { ladder = [], ...rest } = b;
  return { ...rest, ...freshness(b.fetched_at, now, cfg), ladder_count: ladder.length, ...(ladders ? { ladder } : {}) };
}

/**
 * Odds as served: every book entry carries its age and freshness status, a
 * game that has kicked off is left out whatever is still stored for it, and
 * `coverage` says how much of the slate each book's prices really cover.
 */
function decorateOdds(odds, now, cfg, ladders) {
  return {
    ...odds,
    coverage: slateCoverage(odds, now, cfg),
    markets: (odds.markets || []).filter((m) => isPregame(odds, m.game_id, now)).map((m) => {
      const books = m.books.map((b) => serveBook(b, now, cfg, ladders));
      return { ...m, books, best: bestPrices({ books }, now, cfg) };
    }),
  };
}

export async function handleNflApi(request, env, url, now = Date.now()) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  const path = url.pathname.replace(/\/+$/, "");
  const q = url.searchParams;

  if (path === "/api/nfl/teams") return json({ teams: NFL_TEAMS }, 200, 86400);

  if (path === "/api/nfl/odds") {
    const odds = await kv(env, ODDS_KEY);
    if (!odds) return json({ sport: "nfl", updated_at: null, markets: [], games: {}, note: "no NFL odds have been stored" });
    const out = decorateOdds(odds, now, oddsConfig(env), q.get("ladders") === "1");
    const game = q.get("game"), player = q.get("player");
    if (game) out.markets = out.markets.filter((m) => m.game_id === game);
    if (player) out.markets = out.markets.filter((m) => m.player_id === player);
    if (q.get("exposed") !== "all") out.markets = out.markets.filter((m) => m.exposed);
    return json(out);
  }

  // Everything below reads builder payloads: one build per request.
  try {
    return await withSnapshot(env, async (snap) => {
      const res = await builderRoute(snap, env, path, q, now);
      res.headers.set("x-nfl-build", snap.build_id ?? "unversioned");
      return res;
    });
  } catch (err) {
    if (err instanceof SnapshotUnavailable) return json({ error: "NFL data is being republished; try again in a minute" }, 503);
    throw err;
  }
}

async function builderRoute(snap, env, path, q, now) {
  if (path === "/api/nfl/meta") {
    const meta = await snap.get("nfl:meta");
    return meta ? json(meta) : missing("no NFL build has been published yet");
  }

  if (path === "/api/nfl/slate") {
    const slate = await snap.get("nfl:slate:current");
    return slate ? json(slate) : missing("no NFL slate has been published yet");
  }

  if (path === "/api/nfl/defense") {
    const team = (q.get("team") || "").toUpperCase();
    if (!isTeamId(team)) return bad("team must be a canonical NFL team_id, for example BAL");
    const defense = await currentDefense(snap);
    if (!defense) return missing("no defensive data has been published yet");
    const { teams, ...rest } = defense;
    return json({ ...rest, team_id: team, ...(teams[team] || { games: 0, metrics: {}, vs_position: {} }) }, 200, 300);
  }

  if (path === "/api/nfl/injuries") {
    const status = await snap.get("nfl:status:latest");
    if (!status) return missing("no injury data has been published yet");
    const team = (q.get("team") || "").toUpperCase();
    if (!team) return json(status, 200, 300);
    if (!isTeamId(team)) return bad("team must be a canonical NFL team_id");
    const { teams, ...rest } = status;
    return json({ ...rest, team_id: team, ...(teams[team] || { injuries: [], depth_chart: [] }) }, 200, 300);
  }

  if (path === "/api/nfl/player" || path === "/api/nfl/gamelog" || path === "/api/nfl/research") {
    const id = q.get(path === "/api/nfl/research" ? "player" : "id") || "";
    if (!PLAYER_ID.test(id)) return bad("player id must be a GSIS id, for example 00-0034796");
    const index = await snap.get("nfl:players:index");
    const where = index?.players?.[id];
    if (!where) return missing("no such player on a current roster");
    const team = await snap.get(`nfl:team:${where.team_id}`);
    const player = team?.players?.find((p) => p.player_id === id);
    if (!player) return missing("no such player on a current roster");

    if (path === "/api/nfl/gamelog") return json({ player_id: id, season: team.season, as_of_week: team.as_of_week, build_id: team.build_id, game_log: player.game_log }, 200, 300);
    if (path === "/api/nfl/player") return json({ season: team.season, as_of_week: team.as_of_week, data_through_week: team.data_through_week, build_id: team.build_id, player, team: team.team }, 200, 300);

    const prop = q.get("prop");
    if (prop && !PROPS[prop]) return bad(`prop must be one of: ${Object.keys(PROPS).join(", ")}`);
    const [slate, defense, status, odds] = await Promise.all([snap.get("nfl:slate:current"), currentDefense(snap), snap.get("nfl:status:latest"), kv(env, ODDS_KEY)]);
    const research = buildResearch({ playerId: id, propType: prop || undefined, team, slate, defense, status, odds, now, cfg: oddsConfig(env), ladders: q.get("ladders") === "1" });
    return research ? json(research) : missing("no research payload for that player");
  }

  return missing("unknown NFL route");
}
