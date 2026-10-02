// NFL ODDS INGESTION (Worker side): SharpAPI -> KV "nfl:odds:latest".
//
// OFF BY DEFAULT. refreshNflOdds() does nothing unless the Worker var
// NFL_ODDS_ENABLED is "true". Deploying this file does not start any request
// to the provider.
//
// THE FREE-TIER PLAN (12 requests a minute, shared with MLB):
//   every run   DraftKings, the four V1 markets, all games           ~5 pages
//   rotation    FanDuel, the four V1 markets, a few games per run    ~4 pages
// A whole-feed sweep is about 25 pages and does not fit, so each sportsbook
// carries its own `fetched_at` per game and nothing downstream treats an old
// FanDuel price as current (see odds-rules.js: freshness, bestPrices).
//
// The provider's `is_main_line` filter is never sent: it would drop FanDuel's
// real two-sided yardage line and keep an over-only ladder rung.
import { V1_MARKET_TYPES } from "./props.js";
import { normalizeOddsRows, buildBookMarkets, mergeMarkets, FRESHNESS } from "./odds-rules.js";

const SHARPAPI_BASE = "https://api.sharpapi.io/api/v1";
export const ODDS_KEY = "nfl:odds:latest";
export const UNRESOLVED_KEY = "nfl:odds:unresolved";

export const ODDS_DEFAULTS = {
  max_requests: 9,           // per run; leaves room under 12 a minute for MLB's pages
  max_pages_per_sweep: 6,
  fanduel_games_per_run: 3,
  page_size: 200,
};

const intVar = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const oddsConfig = (env = {}) => ({
  ...ODDS_DEFAULTS,
  max_requests: intVar(env.NFL_ODDS_MAX_REQUESTS, ODDS_DEFAULTS.max_requests),
  fanduel_games_per_run: intVar(env.NFL_ODDS_FANDUEL_GAMES, ODDS_DEFAULTS.fanduel_games_per_run),
  fresh_minutes: intVar(env.NFL_ODDS_FRESH_MINUTES, FRESHNESS.fresh_minutes),
  stale_minutes: intVar(env.NFL_ODDS_STALE_MINUTES, FRESHNESS.stale_minutes),
});

/**
 * One filtered sweep of /odds, paging back to back (no pauses: the provider
 * rebuilds its store about once a minute and rejects cursors from an older
 * build).
 *
 * `cursor_expired` restarts the sweep from the first page ONCE; the rows
 * already read are kept and duplicates are removed by row id. A second expiry,
 * a 429, or an exhausted request budget ends the sweep with complete = false,
 * and the caller keeps whatever arrived instead of discarding the refresh.
 */
export async function sweepOdds({ key, params, budget, fetchImpl = fetch, cfg = ODDS_DEFAULTS }) {
  const byId = new Map();
  const order = [];
  let cursor = null, pages = 0, requests = 0, restarts = 0, complete = false, stopped = null;
  while (pages < cfg.max_pages_per_sweep) {
    if (budget.left <= 0) { stopped = "request_budget"; break; }
    const url = new URL(`${SHARPAPI_BASE}/odds`);
    for (const [k, v] of Object.entries({ league: "nfl", limit: cfg.page_size, ...params })) url.searchParams.set(k, String(v));
    if (cursor) url.searchParams.set("cursor", cursor);
    budget.left--; requests++;
    const res = await fetchImpl(url, { headers: { "X-API-Key": key, Accept: "application/json" } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const code = body?.error?.code || null;
      if (res.status === 400 && code === "cursor_expired" && restarts < 1) { restarts++; cursor = null; pages = 0; continue; }
      stopped = code === "cursor_expired" ? "cursor_expired_twice" : res.status === 429 ? "rate_limited" : `http_${res.status}`;
      break;
    }
    pages++;
    for (const row of body?.data || []) {
      const id = row.id ?? `${row.event_id}|${row.sportsbook}|${row.market_type}|${row.player_name}|${row.selection_type}|${row.line}`;
      if (!byId.has(id)) order.push(id);
      byId.set(id, row);
    }
    cursor = body?.pagination?.has_more ? body.pagination.next_cursor : null;
    if (!cursor) { complete = true; break; }
  }
  if (!complete && !stopped) stopped = "page_cap";
  return { rows: order.map((id) => byId.get(id)), pages, requests, restarts, complete, stopped };
}

/**
 * Which games a sweep covered completely. Rows arrive ordered by game, so when
 * a sweep is cut short every game except the LAST one seen is complete. Only
 * complete games replace what is stored; a cut-off game keeps its older data.
 */
export function completeEvents(rows, complete) {
  const events = [];
  for (const r of rows) if (!events.includes(r.event_id)) events.push(r.event_id);
  return new Set(complete ? events : events.slice(0, -1));
}

/** FanDuel rotation: never-fetched first, then the oldest; games inside 3 hours of kickoff weigh triple. */
export function pickFanduelGames(games, books, now, n) {
  return games
    .map((g) => {
      const at = Date.parse(books?.[g.game_id]?.books?.fanduel?.fetched_at);
      const age = Number.isFinite(at) ? (now - at) / 60000 : Infinity;
      const soon = Date.parse(g.kickoff_utc) - now <= 3 * 3600_000;
      return { g, score: age * (soon ? 3 : 1) };
    })
    .sort((a, b) => (a.score === b.score ? 0 : b.score > a.score ? 1 : -1) || String(a.g.kickoff_utc).localeCompare(String(b.g.kickoff_utc)))
    .slice(0, n).map((x) => x.g);
}

/**
 * Entry point for the 10-minute cron. Reads the current slate and rosters the
 * builder wrote to KV, pulls DraftKings and a rotation of FanDuel games,
 * normalizes, and writes the merged payload. Logs counts only.
 */
export async function refreshNflOdds(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (env.NFL_ODDS_ENABLED !== "true") return { skipped: "disabled" };
  if (!env.SHARPAPI_KEY) return { skipped: "no_key" };
  const cfg = oddsConfig(env);
  const [slate, rosters, previous] = await Promise.all([
    env.PROPS_DATA.get("nfl:slate:current", "json"), env.PROPS_DATA.get("nfl:rosters:current", "json"), env.PROPS_DATA.get(ODDS_KEY, "json"),
  ]);
  if (!slate?.games?.length || !rosters?.teams) return { skipped: "no_slate" };
  const pregame = slate.games.filter((g) => Date.parse(g.kickoff_utc) > now);
  if (!pregame.length) return { skipped: "no_pregame_games" };

  const budget = { left: cfg.max_requests };
  const nowIso = new Date(now).toISOString();
  const market = V1_MARKET_TYPES.join(",");
  const ctx = { games: slate.games, rosters: rosters.teams, now };
  const books = { ...(previous?.games || {}) };       // game_id -> { event_id, books: { sportsbook: { fetched_at } } }
  const kept = new Map();                              // game|book -> stored book-market entries
  for (const m of previous?.markets || []) for (const b of m.books) {
    const k = `${m.game_id}|${b.sportsbook}`;
    if (!kept.has(k)) kept.set(k, []);
    const { books: _all, ...head } = m;
    kept.get(k).push({ ...head, book: b });
  }
  const runs = [], quarantine = [], dropped = {};
  const apply = (sweep, sportsbook) => {
    const norm = normalizeOddsRows(sweep.rows, ctx);
    quarantine.push(...norm.quarantine);
    for (const [k, v] of Object.entries(norm.dropped)) dropped[k] = (dropped[k] || 0) + v;
    const done = completeEvents(sweep.rows, sweep.complete);
    const byGame = new Map();
    for (const o of norm.offers) { if (!byGame.has(o.game_id)) byGame.set(o.game_id, []); byGame.get(o.game_id).push(o); }
    for (const [eventId, game] of norm.events) {
      if (!game) continue;
      books[game.game_id] = { ...(books[game.game_id] || {}), event_id: eventId, kickoff_utc: game.kickoff_utc, books: { ...(books[game.game_id]?.books || {}) } };
      if (!done.has(eventId)) continue; // cut off mid-game: keep the older data for this game
      const { entries, implausible } = buildBookMarkets(byGame.get(game.game_id) || [], nowIso);
      for (const x of implausible) quarantine.push({ reason: "implausible_main_line", sportsbook, ...x });
      kept.set(`${game.game_id}|${sportsbook}`, entries);
      books[game.game_id].books[sportsbook] = { fetched_at: nowIso, markets: entries.length };
    }
    runs.push({ sportsbook, requests: sweep.requests, pages: sweep.pages, rows: sweep.rows.length, complete: sweep.complete, restarts: sweep.restarts, stopped: sweep.stopped });
    return new Set([...norm.events.values()].filter(Boolean).map((g) => g.game_id));
  };

  // DraftKings: everything, every run
  const dk = await sweepOdds({ key: env.SHARPAPI_KEY, params: { sportsbook: "draftkings", market }, budget, fetchImpl, cfg });
  const dkGames = apply(dk, "draftkings");
  // a complete sweep with no rows for a game is an answer too: DraftKings has not posted it
  if (dk.complete) for (const g of pregame) if (!dkGames.has(g.game_id)) {
    kept.set(`${g.game_id}|draftkings`, []);
    books[g.game_id] = { ...(books[g.game_id] || {}), kickoff_utc: g.kickoff_utc, books: { ...(books[g.game_id]?.books || {}), draftkings: { fetched_at: nowIso, markets: 0 } } };
  }

  // FanDuel: a rotation of games, by the provider event id learned from earlier rows
  const known = pregame.filter((g) => books[g.game_id]?.event_id);
  for (const g of pickFanduelGames(known, books, now, cfg.fanduel_games_per_run)) {
    if (budget.left <= 0) break;
    const sweep = await sweepOdds({ key: env.SHARPAPI_KEY, params: { sportsbook: "fanduel", market, event_id: books[g.game_id].event_id }, budget, fetchImpl, cfg });
    apply(sweep, "fanduel");
    // a complete sweep that returned nothing still counts as a check: FanDuel has not posted this game
    if (sweep.complete && !sweep.rows.length) { kept.set(`${g.game_id}|fanduel`, []); books[g.game_id].books.fanduel = { fetched_at: nowIso, markets: 0 }; }
  }

  // started games leave the pregame payload entirely
  const live = new Set(pregame.map((g) => g.game_id));
  for (const id of Object.keys(books)) if (!live.has(id)) delete books[id];
  const entries = [];
  for (const [k, list] of kept) if (live.has(k.split("|")[0])) entries.push(...list);
  const markets = mergeMarkets(entries);

  const payload = {
    sport: "nfl", season: slate.season, week: slate.week, updated_at: nowIso,
    freshness_rule: { fresh_minutes: cfg.fresh_minutes, stale_minutes: cfg.stale_minutes },
    games: books, markets,
    counts: { markets: markets.length, exposed_markets: markets.filter((m) => m.exposed).length, unresolved: quarantine.length, dropped },
    runs,
  };
  await env.PROPS_DATA.put(ODDS_KEY, JSON.stringify(payload));
  await recordUnresolved(env, quarantine, nowIso);
  console.log(`NFL odds: ${markets.length} markets (${payload.counts.exposed_markets} exposed), ${quarantine.length} quarantined, ${runs.reduce((a, r) => a + r.requests, 0)} requests; ${runs.map((r) => `${r.sportsbook} ${r.rows} rows${r.complete ? "" : ` (${r.stopped})`}`).join(", ")}`);
  return { markets: markets.length, unresolved: quarantine.length, runs };
}

/**
 * Rows that could not be published, kept whole for review and written only
 * when the set changes. Never served to the app. The log line carries counts
 * by reason, never the rows.
 */
export async function recordUnresolved(env, quarantine, nowIso) {
  const signature = quarantine.map((q) => `${q.reason}|${q.sportsbook}|${q.event_id || q.market_id}|${q.market_type || ""}|${q.player_name || q.line}`).sort().filter((v, i, a) => a.indexOf(v) === i).join("\n");
  const previous = await env.PROPS_DATA.get(UNRESOLVED_KEY, "json");
  if ((previous?.signature || "") === signature) return;
  const byReason = {};
  for (const q of quarantine) byReason[q.reason] = (byReason[q.reason] || 0) + 1;
  await env.PROPS_DATA.put(UNRESOLVED_KEY, JSON.stringify({ updated_at: nowIso, signature, count: quarantine.length, by_reason: byReason, rows: quarantine.slice(0, 200) }));
  console.warn(`NFL odds quarantine changed: ${JSON.stringify(byReason)}`);
}
