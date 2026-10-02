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
//
// WHAT `fetched_at` MEANS. It is stamped on a book's markets for a game only
// when a sweep retrieved that book's rows for that game completely. A game a
// sweep did not reach, a game cut off by a page limit, and every game when a
// run fails keep the prices and the fetched_at they had. A complete sweep that
// returns nothing for a game is an answer (the book has nothing posted): the
// stored lines are removed and the check is stamped. A market that is gone
// from a completely retrieved game (suspended, pulled) is removed, not kept.
// The provider's own timestamp travels separately as `seen_at`.
import { V1_MARKET_TYPES } from "./props.js";
import { normalizeOddsRows, buildBookMarkets, mergeMarkets, FRESHNESS } from "./odds-rules.js";
import { withSnapshot, SnapshotUnavailable } from "./snapshot.js";
import { claimRun, finishRun, recordSkip, pruneRuns } from "./odds-runs.js";

const SHARPAPI_BASE = "https://api.sharpapi.io/api/v1";
export const ODDS_KEY = "nfl:odds:latest";
export const UNRESOLVED_KEY = "nfl:odds:unresolved";
export const PROP_ORDER = ["pass_yds", "rush_yds", "rec_yds", "receptions"];

export const ODDS_DEFAULTS = {
  max_requests: 9,           // per run; leaves room under 12 a minute for MLB's pages
  max_pages_per_sweep: 6,
  fanduel_games_per_run: 3,
  page_size: 200,
  min_interval_minutes: 5,   // no attempt may start this soon after another attempt started (the cron is every 10)
  request_timeout_ms: 15000, // one provider request
};

const intVar = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const oddsConfig = (env = {}) => ({
  ...ODDS_DEFAULTS,
  max_requests: intVar(env.NFL_ODDS_MAX_REQUESTS, ODDS_DEFAULTS.max_requests),
  fanduel_games_per_run: intVar(env.NFL_ODDS_FANDUEL_GAMES, ODDS_DEFAULTS.fanduel_games_per_run),
  // never under 2 minutes: a run must be able to finish inside it
  min_interval_minutes: Math.max(2, intVar(env.NFL_ODDS_MIN_INTERVAL_MINUTES, ODDS_DEFAULTS.min_interval_minutes)),
  fresh_minutes: intVar(env.NFL_ODDS_FRESH_MINUTES, FRESHNESS.fresh_minutes),
  stale_minutes: intVar(env.NFL_ODDS_STALE_MINUTES, FRESHNESS.stale_minutes),
});

/**
 * One filtered sweep of /odds, paging back to back (no pauses: the provider
 * rebuilds its store about once a minute and rejects cursors from an older
 * build).
 *
 * `cursor_expired` restarts the sweep from the first page ONCE; the rows
 * already read are kept and duplicates are removed by row id. Anything else
 * that goes wrong ends the sweep with complete = false, and the caller keeps
 * whatever arrived instead of discarding the refresh.
 *
 * The provider reports what is left of the per-minute allowance in
 * x-ratelimit-remaining. When it reaches RATE_RESERVE nothing more is sent in
 * this run, so NFL never spends the last requests of a minute. A 429, a
 * timeout, a network error or any other failed response also ends the whole
 * run, not just the sweep: a provider that is failing is not asked again.
 */
export const RATE_RESERVE = 1;
export async function sweepOdds({ key, params, budget, fetchImpl = fetch, cfg = ODDS_DEFAULTS }) {
  const byId = new Map();
  const order = [];
  let cursor = null, pages = 0, requests = 0, restarts = 0, complete = false, stopped = null;
  while (pages < cfg.max_pages_per_sweep) {
    if (budget.left <= 0) { stopped = "request_budget"; break; }
    if (budget.deadline && Date.now() > budget.deadline) { budget.left = 0; stopped = "deadline"; break; }
    const url = new URL(`${SHARPAPI_BASE}/odds`);
    for (const [k, v] of Object.entries({ league: "nfl", limit: cfg.page_size, ...params })) url.searchParams.set(k, String(v));
    if (cursor) url.searchParams.set("cursor", cursor);
    budget.left--; requests++;
    let res;
    try {
      res = await fetchImpl(url, { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(cfg.request_timeout_ms ?? ODDS_DEFAULTS.request_timeout_ms) });
    } catch (err) {
      budget.left = 0;
      stopped = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "network_error";
      break;
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const code = body?.error?.code || null;
      if (res.status === 400 && code === "cursor_expired" && restarts < 1) { restarts++; cursor = null; pages = 0; continue; }
      stopped = code === "cursor_expired" ? "cursor_expired_twice" : res.status === 429 ? "rate_limited" : `http_${res.status}`;
      if (stopped !== "cursor_expired_twice") budget.left = 0;
      break;
    }
    pages++;
    for (const row of body?.data || []) {
      const id = row.id ?? `${row.event_id}|${row.sportsbook}|${row.market_type}|${row.player_name}|${row.selection_type}|${row.line}`;
      if (!byId.has(id)) order.push(id);
      byId.set(id, row);
    }
    // what the provider says is left of this minute, recorded on every response
    const header = res.headers?.get?.("x-ratelimit-remaining");
    const remaining = header == null ? NaN : Number(header);
    const nearLimit = Number.isFinite(remaining) && remaining <= RATE_RESERVE;
    if (Number.isFinite(remaining)) budget.provider_remaining = remaining;
    if (nearLimit) budget.left = 0; // nothing else is sent in this run, by this sweep or the next
    cursor = body?.pagination?.has_more ? body.pagination.next_cursor : null;
    if (!cursor) { complete = true; break; }
    if (nearLimit) { stopped = "provider_rate_limit_near"; break; }
  }
  if (!complete && !stopped) stopped = "page_cap";
  return { rows: order.map((id) => byId.get(id)), pages, requests, restarts, complete, stopped };
}

/**
 * Which games a sweep covered completely. Rows arrive ordered by game, so when
 * a sweep is cut short every game except the LAST one seen is complete. Only
 * complete games replace what is stored; a cut-off game keeps its older data.
 *
 * That rests on the ordering. If a cut-short sweep shows any game's rows in
 * two separate runs of rows, the ordering did not hold and NO game of that
 * sweep is treated as complete.
 */
export function completeEvents(rows, complete) {
  const events = [];
  let ordered = true;
  for (let i = 0; i < rows.length; i++) {
    const id = rows[i].event_id;
    if (i > 0 && rows[i - 1].event_id === id) continue;
    if (events.includes(id)) ordered = false; else events.push(id);
  }
  if (complete) return new Set(events);
  return new Set(ordered ? events.slice(0, -1) : []);
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
 * What one completed look at a book's game found, per V1 prop in PROP_ORDER:
 * [markets with a two-sided main line, the provider's newest timestamp on them].
 * [0, null] means the book was checked and had nothing posted for that prop.
 */
function observe(entries) {
  return PROP_ORDER.map((prop) => {
    const posted = entries.filter((e) => e.prop_type === prop && e.book.main);
    const newest = posted.reduce((a, e) => (e.book.seen_at && String(e.book.seen_at) > a ? String(e.book.seen_at) : a), "");
    return [posted.length, newest || null];
  });
}

const firstLine = (err) => String(err?.message ?? err).split(/\r?\n/)[0].slice(0, 300);

/**
 * Entry point for the 10-minute cron. Reads the current slate and rosters the
 * builder wrote to KV, pulls DraftKings and a rotation of FanDuel games,
 * normalizes, and writes the merged payload. Logs counts only.
 *
 * Every run that gets past the on/off switch leaves a row in the D1 run
 * ledger (odds-runs.js): an attempt, with its outcome, or a skip, with its
 * reason. The attempt row is also the lock: it is claimed atomically before
 * the first provider request, and without it no request is sent.
 *
 * Returns { skipped: reason }, { failed: reason }, or { markets, unresolved,
 * runs, outcome }. It throws only on an unexpected error, after recording it.
 */
export async function refreshNflOdds(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  if (env.NFL_ODDS_ENABLED !== "true") return { skipped: "disabled" };
  if (!env.SHARPAPI_KEY) return { skipped: "no_key" };
  // No ledger, no lock, no provider call.
  if (!env.NFL_DB) return { skipped: "no_run_ledger" };
  const cfg = oddsConfig(env);
  const wallStart = Date.now();
  const nowIso = new Date(now).toISOString();
  const runId = `${nowIso}-${crypto.randomUUID().slice(0, 8)}`;
  // "live" only when the rows came from the provider through the real fetch.
  // A payload built from a fixture or a capture can never carry that label.
  const source = fetchImpl === globalThis.fetch ? "live" : "fixture";
  const skip = async (reason) => {
    try { await recordSkip(env.NFL_DB, { runId, at: nowIso, reason, source }); } catch (err) { console.warn(`NFL odds: skip "${reason}" not recorded: ${firstLine(err)}`); }
    return { skipped: reason };
  };

  // the slate and the rosters come from one build, never one of each
  let slate, rosters;
  try {
    [slate, rosters] = await withSnapshot(env, (snap) => Promise.all([snap.get("nfl:slate:current"), snap.get("nfl:rosters:current")]));
  } catch (err) {
    if (err instanceof SnapshotUnavailable) return skip("snapshot_unavailable");
    throw err;
  }
  if (!slate?.games?.length || !rosters?.teams) return skip("no_slate");
  const pregame = slate.games.filter((g) => Date.parse(g.kickoff_utc) > now);
  if (!pregame.length) return skip("no_pregame_games");

  // The lock. One conditional INSERT in D1: of any invocations starting inside
  // the minimum interval, exactly one gets the row. If the ledger cannot be
  // reached the run does not happen.
  let claimed;
  try {
    claimed = await claimRun(env.NFL_DB, { runId, startedAt: nowIso, source, minIntervalMs: cfg.min_interval_minutes * 60000 });
  } catch (err) {
    console.warn(`NFL odds: the run ledger could not be reached, nothing was requested: ${firstLine(err)}`);
    return { skipped: "run_ledger_unavailable" };
  }
  if (!claimed) return skip("too_soon");

  // a run ends well inside the interval it holds: a minute of margin, and one request can outlast the deadline by its timeout only
  const budget = { left: cfg.max_requests, deadline: wallStart + cfg.min_interval_minutes * 60000 - 60000 };
  const runs = [], quarantine = [], dropped = {}, observed = [];
  const detail = { pregame_games: pregame.map((g) => g.game_id), fanduel_planned: [], sweeps: observed, stored: false };
  const requestsSent = () => runs.reduce((a, r) => a + r.requests, 0);
  const finish = async (outcome, reason = null) => {
    try {
      await finishRun(env.NFL_DB, { runId, finishedAt: new Date(now + (Date.now() - wallStart)).toISOString(), outcome, reason, requests: requestsSent(), providerLeft: budget.provider_remaining ?? null, detail });
      await pruneRuns(env.NFL_DB, now);
    } catch (err) { console.warn(`NFL odds: run outcome "${outcome}" not recorded: ${firstLine(err)}`); }
  };

  try {
    // read under the lock: this run is the only one merging into the stored payload
    const previous = await env.PROPS_DATA.get(ODDS_KEY, "json");
    const market = V1_MARKET_TYPES.join(",");
    const ctx = { games: slate.games, rosters: rosters.teams, now };
    const pregameIds = new Set(pregame.map((g) => g.game_id));
    const books = { ...(previous?.games || {}) };       // game_id -> { event_id, books: { sportsbook: { fetched_at } } }
    const kept = new Map();                              // game|book -> stored book-market entries
    for (const m of previous?.markets || []) for (const b of m.books) {
      const k = `${m.game_id}|${b.sportsbook}`;
      if (!kept.has(k)) kept.set(k, []);
      const { books: _all, ...head } = m;
      kept.get(k).push({ ...head, book: b });
    }
    let retrieved = 0; // (game, book) pairs this run actually retrieved, lines or a confirmed nothing
    const apply = (sweep, sportsbook) => {
      const norm = normalizeOddsRows(sweep.rows, ctx);
      quarantine.push(...norm.quarantine);
      for (const [k, v] of Object.entries(norm.dropped)) dropped[k] = (dropped[k] || 0) + v;
      const done = completeEvents(sweep.rows, sweep.complete);
      const byGame = new Map();
      for (const o of norm.offers) { if (!byGame.has(o.game_id)) byGame.set(o.game_id, []); byGame.get(o.game_id).push(o); }
      const seen = {};
      for (const [eventId, game] of norm.events) {
        if (!game) continue;
        books[game.game_id] = { ...(books[game.game_id] || {}), event_id: eventId, kickoff_utc: game.kickoff_utc, books: { ...(books[game.game_id]?.books || {}) } };
        if (!done.has(eventId)) continue; // cut off mid-game: keep the older data and its older fetched_at
        const { entries, implausible } = buildBookMarkets(byGame.get(game.game_id) || [], nowIso);
        for (const x of implausible) quarantine.push({ reason: "implausible_main_line", sportsbook, ...x });
        kept.set(`${game.game_id}|${sportsbook}`, entries);
        books[game.game_id].books[sportsbook] = { fetched_at: nowIso, markets: entries.length };
        if (pregameIds.has(game.game_id)) { seen[game.game_id] = observe(entries); retrieved++; }
      }
      runs.push({ sportsbook, requests: sweep.requests, pages: sweep.pages, rows: sweep.rows.length, complete: sweep.complete, restarts: sweep.restarts, stopped: sweep.stopped });
      const log = { sportsbook, requests: sweep.requests, rows: sweep.rows.length, complete: sweep.complete, stopped: sweep.stopped, games: seen };
      observed.push(log);
      return { games: new Set([...norm.events.values()].filter(Boolean).map((g) => g.game_id)), log };
    };

    // DraftKings: everything, every run
    const dk = await sweepOdds({ key: env.SHARPAPI_KEY, params: { sportsbook: "draftkings", market }, budget, fetchImpl, cfg });
    const dkApplied = apply(dk, "draftkings");
    // a complete sweep with no rows for a game is an answer too: DraftKings has not posted it
    if (dk.complete) for (const g of pregame) if (!dkApplied.games.has(g.game_id)) {
      kept.set(`${g.game_id}|draftkings`, []);
      books[g.game_id] = { ...(books[g.game_id] || {}), kickoff_utc: g.kickoff_utc, books: { ...(books[g.game_id]?.books || {}), draftkings: { fetched_at: nowIso, markets: 0 } } };
      dkApplied.log.games[g.game_id] = observe([]); retrieved++;
    }

    // FanDuel: a rotation of games, by the provider event id learned from earlier rows
    const known = pregame.filter((g) => books[g.game_id]?.event_id);
    const rotation = pickFanduelGames(known, books, now, cfg.fanduel_games_per_run);
    detail.fanduel_planned = rotation.map((g) => g.game_id);
    for (const g of rotation) {
      if (budget.left <= 0) break;
      const sweep = await sweepOdds({ key: env.SHARPAPI_KEY, params: { sportsbook: "fanduel", market, event_id: books[g.game_id].event_id }, budget, fetchImpl, cfg });
      const applied = apply(sweep, "fanduel");
      applied.log.game_id = g.game_id;
      // a complete sweep that returned nothing still counts as a check: FanDuel has not posted this game
      if (sweep.complete && !sweep.rows.length) { kept.set(`${g.game_id}|fanduel`, []); books[g.game_id].books.fanduel = { fetched_at: nowIso, markets: 0 }; applied.log.games[g.game_id] = observe([]); retrieved++; }
    }

    // Nothing was retrieved: nothing is written, so no stored time moves.
    if (!retrieved) {
      const reason = runs.find((r) => r.stopped)?.stopped || "nothing_retrieved";
      await finish("failed", reason);
      console.warn(`NFL odds: nothing retrieved (${reason}), ${requestsSent()} requests; stored odds left as they were`);
      return { failed: reason, runs };
    }

    // started games leave the pregame payload entirely
    for (const id of Object.keys(books)) if (!pregameIds.has(id)) delete books[id];
    const entries = [];
    for (const [k, list] of kept) if (pregameIds.has(k.split("|")[0])) entries.push(...list);
    const markets = mergeMarkets(entries);

    const payload = {
      sport: "nfl", season: slate.season, week: slate.week,
      // the time of the last run that retrieved anything. It says nothing about any one book or game: read fetched_at.
      updated_at: nowIso, source,
      freshness_rule: { fresh_minutes: cfg.fresh_minutes, stale_minutes: cfg.stale_minutes },
      games: books, markets,
      counts: { markets: markets.length, exposed_markets: markets.filter((m) => m.exposed).length, unresolved: quarantine.length, dropped },
      runs,
      provider_requests_left: budget.provider_remaining ?? null,
    };
    await env.PROPS_DATA.put(ODDS_KEY, JSON.stringify(payload));
    detail.stored = true;
    await recordUnresolved(env, quarantine, nowIso);
    const outcome = runs.every((r) => r.complete) ? "success" : "partial";
    await finish(outcome, outcome === "partial" ? runs.filter((r) => !r.complete).map((r) => `${r.sportsbook}: ${r.stopped}`).join("; ") : null);
    console.log(`NFL odds: ${markets.length} markets (${payload.counts.exposed_markets} exposed), ${quarantine.length} quarantined, ${requestsSent()} requests; ${runs.map((r) => `${r.sportsbook} ${r.rows} rows${r.complete ? "" : ` (${r.stopped})`}`).join(", ")}`);
    return { markets: markets.length, unresolved: quarantine.length, runs, outcome };
  } catch (err) {
    // If the payload was already stored the odds are good; only a later step failed.
    await finish(detail.stored ? "partial" : "failed", `error: ${firstLine(err)}`);
    throw err;
  }
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
