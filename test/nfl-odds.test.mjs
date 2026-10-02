// NFL odds: main-line selection, FanDuel's ladder, book-specific lines,
// freshness, live and suspended rows, duplicates, player quarantine, and
// cursor-expiry recovery. Runs on the synthetic feed (real players and games,
// made-up prices, the structure the 2026-10-02 probe observed). The real capture
// is checked separately in nfl-odds-capture.test.mjs when it is on the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { loadOddsRows, derive, memoryKv } from "./fixtures/nfl/load.mjs";
import { impliedProbability, selectMainLine, freshness, bestPrices, normalizeOddsRows, buildBookMarkets, mergeMarkets, FRESHNESS } from "../src/nfl/odds-rules.js";
import { sweepOdds, completeEvents, pickFanduelGames, refreshNflOdds, ODDS_KEY, UNRESOLVED_KEY, ODDS_DEFAULTS } from "../src/nfl/odds.js";
import { buildPayloads } from "../etl/nfl/payloads.mjs";
import { V1_MARKET_TYPES, PROPS } from "../src/nfl/props.js";

const rows = loadOddsRows();
const { derived } = derive();
const payloads = buildPayloads(derived);
const slate = payloads["nfl:slate:current"], rosters = payloads["nfl:rosters:current"];
const CAPTURE = Date.parse("2026-10-02T03:07:00Z");
const ctx = { games: slate.games, rosters: rosters.teams, now: CAPTURE };
const norm = normalizeOddsRows(rows, ctx);
const byBook = (book) => norm.offers.filter((o) => o.sportsbook === book);
const marketsFor = (offers, at = "2026-10-02T03:07:00.000Z") => mergeMarkets(buildBookMarkets(offers, at).entries);
const markets = mergeMarkets([...buildBookMarkets(byBook("draftkings"), "2026-10-02T03:07:00.000Z").entries, ...buildBookMarkets(byBook("fanduel"), "2026-10-02T03:07:00.000Z").entries]);
const find = (name, prop) => markets.find((m) => m.player_name === name && m.prop_type === prop);

test("V1 is locked to four provider markets", () => {
  assert.deepEqual([...V1_MARKET_TYPES].sort(), ["player_passing_yards", "player_receiving_yards", "player_receptions", "player_rushing_yards"]);
  assert.deepEqual(Object.keys(PROPS).sort(), ["pass_yds", "rec_yds", "receptions", "rush_yds"]);
  assert.equal(new Set(norm.offers.map((o) => o.market_type)).size, 4);
  assert.ok(norm.dropped.other_market > 300, "attempts, completions, longest plays and kicker markets are not stored in V1");
});

test("implied probability from American odds", () => {
  assert.ok(Math.abs(impliedProbability(-110) - 0.5238) < 1e-4);
  assert.ok(Math.abs(impliedProbability(150) - 0.4) < 1e-9);
  assert.equal(impliedProbability(null), null);
  assert.equal(impliedProbability(0), null);
});

test("main line: the two-sided line with the closest prices", () => {
  const main = selectMainLine([{ line: 49.5, over: -120, under: null }, { line: 50.5, over: -114, under: -114 }, { line: 59.5, over: 130, under: null }]);
  assert.equal(main.line, 50.5);
  assert.equal(main.over, -114); assert.equal(main.under, -114);
  assert.ok(main.hold > 0.06 && main.hold < 0.07);
});

test("main line: an over-only ladder has no main line at all", () => {
  assert.equal(selectMainLine([{ line: 39.5, over: -200, under: null }, { line: 49.5, over: -120, under: null }, { line: 59.5, over: 130, under: null }]), null);
  assert.equal(selectMainLine([]), null);
});

test("main line: among several two-sided lines the most balanced wins; ties go to the smaller hold, then the middle, then the lower", () => {
  assert.equal(selectMainLine([{ line: 60.5, over: -160, under: 130 }, { line: 64.5, over: -112, under: -108 }, { line: 68.5, over: 135, under: -165 }]).line, 64.5);
  // equal balance (both dead even): the smaller hold wins
  assert.equal(selectMainLine([{ line: 20.5, over: -115, under: -115 }, { line: 21.5, over: -110, under: -110 }]).line, 21.5);
  // equal balance and hold: three candidates, the middle one; two candidates, the lower one
  assert.equal(selectMainLine([{ line: 10.5, over: -110, under: -110 }, { line: 11.5, over: -110, under: -110 }, { line: 12.5, over: -110, under: -110 }]).line, 11.5);
  assert.equal(selectMainLine([{ line: 10.5, over: -110, under: -110 }, { line: 11.5, over: -110, under: -110 }]).line, 10.5);
});

test("FanDuel ladder: Terry McLaurin's main line is the two-sided 50.5, not the flagged 49.5 rung", () => {
  const m = find("Terry McLaurin", "rec_yds");
  const fd = m.books.find((b) => b.sportsbook === "fanduel"), dk = m.books.find((b) => b.sportsbook === "draftkings");
  assert.equal(fd.main.line, 50.5);
  assert.equal(fd.main.over, -114); assert.equal(fd.main.under, -114);
  assert.equal(fd.provider_flagged_line, 49.5, "the provider flagged an over-only rung as main; it is recorded and ignored");
  assert.ok(fd.ladder.length >= 12, "the ladder is stored");
  assert.ok(fd.ladder.every((l) => l.line !== 50.5), "the main line is not repeated in the ladder");
  assert.ok(fd.ladder.every((l) => l.under == null), "every rung is over-only");
  assert.equal(dk.main.line, 51.5);
  assert.equal(dk.ladder.length, 0, "DraftKings sends no alternates");
});

test("no ladder rung ever becomes a main line, for any FanDuel market", () => {
  const fd = markets.flatMap((m) => m.books.filter((b) => b.sportsbook === "fanduel").map((b) => ({ m, b })));
  assert.ok(fd.length >= 20);
  let flaggedElsewhere = 0;
  for (const { b } of fd) {
    if (!b.main) continue;
    assert.ok(Number.isFinite(b.main.over) && Number.isFinite(b.main.under), "a main line always has both prices");
    if (b.provider_flagged_line != null && b.provider_flagged_line !== b.main.line) flaggedElsewhere++;
  }
  assert.ok(flaggedElsewhere >= 5, `the provider flag pointed at a different line in ${flaggedElsewhere} FanDuel markets`);
});

test("DraftKings: one two-sided main line per market, found by the same rule", () => {
  const dk = markets.flatMap((m) => m.books.filter((b) => b.sportsbook === "draftkings"));
  const withMain = dk.filter((b) => b.main);
  assert.ok(withMain.length > 150);
  for (const b of withMain) assert.equal(b.main.two_sided_lines, 1);
  const agree = withMain.filter((b) => b.provider_flagged_line === b.main.line).length;
  assert.equal(agree, withMain.length, "for DraftKings the flag and the rule agree today; the rule does not depend on it");
});

test("book-specific lines are preserved: DK 51.5 and FD 50.5 are never merged into one line", () => {
  const m = find("Terry McLaurin", "rec_yds");
  const best = bestPrices({ books: m.books }, CAPTURE);
  assert.equal(best.lines_differ, true);
  assert.deepEqual(best.lines.map((l) => l.line), [50.5, 51.5]);
  for (const l of best.lines) { assert.equal(l.books.length, 1); assert.equal(l.best_over.sportsbook, l.books[0].sportsbook); }
  // each book entry keeps book, line, Over price and Under price
  for (const b of m.books) for (const f of ["sportsbook", "fetched_at"]) assert.ok(b[f]);
  for (const b of m.books) assert.ok(b.main.line && b.main.over && b.main.under);
});

test("prices are compared only where the books post the same number", () => {
  const m = find("Terry McLaurin", "receptions");
  const best = bestPrices({ books: m.books }, CAPTURE);
  assert.equal(best.lines.length, 1, "both books post 4.5 receptions");
  assert.equal(best.lines[0].line, 4.5);
  assert.equal(best.lines[0].compared_books, 2);
  assert.equal(best.lines[0].best_over.sportsbook, "fanduel", "+120 beats +116");
  assert.equal(best.lines[0].best_under.sportsbook, "draftkings", "-148 beats -160");
});

test("freshness: fresh to 15 minutes, aging to 30, stale after", () => {
  const at = "2026-10-04T16:00:00.000Z", t = Date.parse(at);
  assert.deepEqual(freshness(at, t + 5 * 60000), { age_minutes: 5, status: "fresh" });
  assert.equal(freshness(at, t + 15 * 60000).status, "fresh");
  assert.equal(freshness(at, t + 15.5 * 60000).status, "aging");
  assert.equal(freshness(at, t + 30 * 60000).status, "aging");
  assert.equal(freshness(at, t + 31 * 60000).status, "stale");
  assert.equal(freshness(null, t).status, "stale", "an unknown fetch time is never treated as current");
  assert.equal(freshness(at, t + 20 * 60000, { fresh_minutes: 30, stale_minutes: 60 }).status, "fresh", "the thresholds are configurable");
  assert.deepEqual(FRESHNESS, { fresh_minutes: 15, stale_minutes: 30 });
});

test("a stale FanDuel price never beats a current DraftKings price", () => {
  const now = Date.parse("2026-10-04T16:00:00.000Z");
  const books = [
    { sportsbook: "draftkings", fetched_at: "2026-10-04T15:55:00.000Z", main: { line: 4.5, over: 116, under: -148 } },
    { sportsbook: "fanduel", fetched_at: "2026-10-04T15:10:00.000Z", main: { line: 4.5, over: 140, under: -120 } }, // better on both sides, 50 minutes old
  ];
  const line = bestPrices({ books }, now).lines[0];
  assert.equal(line.best_over.sportsbook, "draftkings");
  assert.equal(line.best_under.sportsbook, "draftkings");
  assert.deepEqual(line.stale_books, ["fanduel"]);
  assert.equal(line.compared_books, 1);
  assert.equal(line.books.find((b) => b.sportsbook === "fanduel").status, "stale", "the stale price is still listed, labeled, with its age");
  assert.equal(line.books.find((b) => b.sportsbook === "fanduel").age_minutes, 50);
  // the same FanDuel price when it is only aging may be best, and says how old it is
  books[1].fetched_at = "2026-10-04T15:40:00.000Z";
  const aging = bestPrices({ books }, now).lines[0];
  assert.equal(aging.best_over.sportsbook, "fanduel");
  assert.equal(aging.best_over.status, "aging");
  assert.equal(aging.best_over.age_minutes, 20);
  // every book stale: there is no best price at all
  const all = bestPrices({ books: books.map((b) => ({ ...b, fetched_at: "2026-10-04T14:00:00.000Z" })) }, now).lines[0];
  assert.equal(all.best_over, null);
});

test("live rows are dropped: the game in progress contributes nothing", () => {
  const live = rows.filter((r) => r.is_live === true);
  assert.ok(live.length >= 30, "the capture includes a game in progress");
  assert.equal(norm.dropped.live, live.filter((r) => V1_MARKET_TYPES.includes(r.market_type)).length);
  assert.ok(!norm.offers.some((o) => o.event_id.includes("browns_steelers")), "no offer from the live Thursday game");
  assert.ok(!markets.some((m) => m.game_id === "2026_04_PIT_CLE"));
});

test("suspended or unavailable rows are dropped", () => {
  const sample = rows.find((r) => !r.is_live && r.market_type === "player_receptions");
  const out = normalizeOddsRows([{ ...sample, id: "x1", is_active: false }, { ...sample, id: "x2", is_stale_pregame_price: true }, { ...sample, id: "x3" }], ctx);
  assert.equal(out.dropped.inactive, 1);
  assert.equal(out.dropped.stale_flag, 1);
  assert.equal(out.offers.length, 1);
});

test("a game that has kicked off is not in the pregame data, whatever the feed says", () => {
  const later = normalizeOddsRows(rows, { ...ctx, now: Date.parse("2026-10-04T18:00:00Z") });
  assert.ok(later.dropped.started > 400, "Sunday's early games are dropped once the schedule says they started");
  assert.ok(!later.offers.some((o) => o.game_id === "2026_04_IND_WAS"));
});

test("duplicates are removed: the same row twice, and the same offer under two ids", () => {
  const sample = rows.filter((r) => !r.is_live && r.market_type === "player_passing_yards").slice(0, 4);
  const once = normalizeOddsRows(sample, ctx);
  const twice = normalizeOddsRows([...sample, ...sample], ctx);
  assert.equal(twice.offers.length, once.offers.length);
  assert.equal(twice.dropped.duplicate, sample.length);
  const reissued = normalizeOddsRows([...sample, { ...sample[0], id: "new-id", odds_american: sample[0].odds_american - 5, timestamp: "2026-10-02T03:09:00Z" }], ctx);
  assert.equal(reissued.offers.length, once.offers.length, "one offer per market, book, side and line");
  const same = (o) => o.sportsbook === sample[0].sportsbook && o.line === Number(sample[0].line) && o.side === sample[0].selection_type && o.feed_name === sample[0].player_name;
  assert.equal(reissued.offers.find(same).price, sample[0].odds_american - 5, "the later timestamp wins");
  assert.equal(norm.dropped.duplicate, 0, "the feed itself has no duplicates");
});

test("players resolve to canonical ids; names are display fields", () => {
  assert.equal(norm.quarantine.length, 0, "every V1 row resolves");
  for (const o of norm.offers) {
    assert.match(o.player_id, /^\d{2}-\d{7}$/);
    assert.match(o.market_id, /^nfl:2026_04_[A-Z]+_[A-Z]+:\d{2}-\d{7}:(pass_yds|rush_yds|rec_yds|receptions)$/);
    assert.ok(o.team_id && o.position && o.game_id);
  }
  const gainwell = norm.offers.find((o) => o.feed_name === "Kenneth Gainwell");
  assert.equal(gainwell.player_name, "Kenny Gainwell", "the feed's Kenneth is the roster's Kenny");
  const skattebo = norm.offers.find((o) => o.feed_name === "Cameron Skattebo");
  assert.equal(skattebo.player_name, "Cam Skattebo");
  assert.ok(["exact", "variant"].includes(skattebo.match_method), "by the roster's legal first name, or by the name-variant rule");
});

test("an unresolved or ambiguous player is quarantined whole and never published", () => {
  const sample = rows.find((r) => !r.is_live && r.market_type === "player_receiving_yards" && r.event_id.includes("colts_commanders"));
  const ghost = { ...sample, id: "g1", player_name: "Nobody Realname" };
  const out = normalizeOddsRows([ghost, { ...sample, id: "g2" }], ctx);
  assert.equal(out.offers.length, 1);
  assert.equal(out.quarantine.length, 1);
  assert.equal(out.quarantine[0].reason, "no_match");
  assert.equal(out.quarantine[0].row.player_name, "Nobody Realname", "the raw row is kept for review");
  // ambiguity: two rostered players with one name
  const extra = { player_id: "00-9999999", display_name: sample.player_name, position: "WR", status: "ACT" };
  const twin = { ...ctx, rosters: { ...ctx.rosters, WAS: [...ctx.rosters.WAS, extra], IND: [...ctx.rosters.IND, extra] } };
  const amb = normalizeOddsRows([{ ...sample, id: "g3" }], twin);
  assert.equal(amb.offers.length, 0);
  assert.equal(amb.quarantine[0].reason, "ambiguous_exact");
});

test("an unknown team and a game not on the schedule are quarantined", () => {
  const sample = rows.find((r) => !r.is_live && r.market_type === "player_receptions");
  const badTeam = normalizeOddsRows([{ ...sample, id: "t1", home: { abbreviation: "XXX", name: "Nowhere" }, home_team: "Nowhere" }], ctx);
  assert.equal(badTeam.quarantine[0].reason, "unknown_team");
  const noGame = normalizeOddsRows([{ ...sample, id: "t2", event_id: "nfl_other", event_start_time: "2026-11-20T18:00Z" }], ctx);
  assert.equal(noGame.quarantine[0].reason, "no_matching_game");
});

test("position gate: a quarterback's rushing yards and a running back's receptions are stored but not exposed in V1", () => {
  const qbRush = markets.filter((m) => m.prop_type === "rush_yds" && m.position === "QB");
  const rbRec = markets.filter((m) => m.prop_type === "receptions" && m.position === "RB");
  assert.ok(qbRush.length > 5 && rbRec.length > 5);
  for (const m of [...qbRush, ...rbRec]) assert.equal(m.exposed, false);
  for (const m of markets.filter((x) => x.prop_type === "pass_yds")) { assert.equal(m.position, "QB"); assert.equal(m.exposed, true); }
  assert.ok(markets.filter((m) => m.exposed).every((m) => PROPS[m.prop_type].exposed.includes(m.position)));
  // a non-quarterback priced in the passing-yards market is a bad match, not a prop
  const wrRow = rows.find((r) => !r.is_live && r.market_type === "player_receiving_yards" && r.event_id.includes("colts_commanders"));
  const wrong = normalizeOddsRows([{ ...wrRow, id: "p1", market_type: "player_passing_yards" }], ctx);
  assert.equal(wrong.quarantine[0].reason, "position_not_allowed");
});

test("a main line outside the sanity bounds is withheld and reported", () => {
  const o = norm.offers.filter((x) => x.sportsbook === "draftkings" && x.prop_type === "receptions").slice(0, 2).map((x) => ({ ...x, market_id: "m", line: 44.5 }));
  const { entries, implausible } = buildBookMarkets([{ ...o[0], side: "over" }, { ...o[0], side: "under" }], "2026-10-02T03:07:00.000Z");
  assert.equal(entries[0].book.main, null);
  assert.equal(implausible.length, 1);
});

// ---------- paging ----------
const page = (data, cursor) => ({ ok: true, status: 200, json: async () => ({ data, pagination: { has_more: !!cursor, next_cursor: cursor || null } }) });
const expired = () => ({ ok: false, status: 400, json: async () => ({ error: { code: "cursor_expired", restart: true } }) });
const dk = rows.filter((r) => r.sportsbook === "draftkings" && V1_MARKET_TYPES.includes(r.market_type) && !r.is_live);
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

test("paging is continuous and stops at the end of the feed", async () => {
  const pages = chunk(dk, 100);
  let calls = 0;
  const fetchImpl = async (url) => { const c = url.searchParams.get("cursor"); const i = c ? Number(c) : 0; calls++; return page(pages[i], i + 1 < pages.length ? String(i + 1) : null); };
  const out = await sweepOdds({ key: "test-key", params: { sportsbook: "draftkings" }, budget: { left: 20 }, fetchImpl, cfg: { ...ODDS_DEFAULTS, max_pages_per_sweep: 20 } });
  assert.equal(out.complete, true);
  assert.equal(out.rows.length, dk.length);
  assert.equal(out.requests, pages.length);
  assert.equal(calls, pages.length);
});

test("cursor expiry: the sweep restarts once from the first page, keeps what it read and removes duplicates", async () => {
  const pages = chunk(dk, 100);
  let failed = false;
  const fetchImpl = async (url) => {
    const c = url.searchParams.get("cursor"); const i = c ? Number(c) : 0;
    if (i === 2 && !failed) { failed = true; return expired(); }
    return page(pages[i], i + 1 < pages.length ? String(i + 1) : null);
  };
  const out = await sweepOdds({ key: "test-key", params: {}, budget: { left: 30 }, fetchImpl, cfg: { ...ODDS_DEFAULTS, max_pages_per_sweep: 20 } });
  assert.equal(out.complete, true, "the refresh is not lost");
  assert.equal(out.restarts, 1);
  assert.equal(out.rows.length, dk.length, "rows read before the restart are not duplicated");
  assert.equal(new Set(out.rows.map((r) => r.id)).size, dk.length);
  assert.equal(out.requests, 2 + 1 + pages.length, "two pages, the expired request, then the whole sweep again");
});

test("a second expiry, a 429 or the request budget ends the sweep without throwing, keeping the rows read", async () => {
  const pages = chunk(dk, 100);
  const always = async (url) => { const c = url.searchParams.get("cursor"); return c ? expired() : page(pages[0], "1"); };
  const twice = await sweepOdds({ key: "k", params: {}, budget: { left: 30 }, fetchImpl: always });
  assert.equal(twice.complete, false);
  assert.equal(twice.stopped, "cursor_expired_twice");
  assert.equal(twice.rows.length, 100);
  const limited = await sweepOdds({ key: "k", params: {}, budget: { left: 30 }, fetchImpl: async (url) => (url.searchParams.get("cursor") ? { ok: false, status: 429, json: async () => ({}) } : page(pages[0], "1")) });
  assert.equal(limited.stopped, "rate_limited");
  assert.equal(limited.rows.length, 100);
  const budget = { left: 2 };
  const capped = await sweepOdds({ key: "k", params: {}, budget, fetchImpl: async (url) => { const c = url.searchParams.get("cursor"); const i = c ? Number(c) : 0; return page(pages[i], String(i + 1)); } });
  assert.equal(capped.stopped, "request_budget");
  assert.equal(capped.requests, 2);
  assert.equal(budget.left, 0);
});

test("a sweep cut short replaces only the games it covered completely", () => {
  const events = [...new Set(dk.map((r) => r.event_id))];
  assert.deepEqual([...completeEvents(dk, true)], events);
  assert.deepEqual([...completeEvents(dk, false)], events.slice(0, -1), "the last game seen may be incomplete, so it keeps its older data");
});

test("FanDuel rotation: never-fetched games first, then the oldest, with games near kickoff weighted", () => {
  const now = Date.parse("2026-10-04T15:00:00Z");
  const games = [{ game_id: "A", kickoff_utc: "2026-10-04T17:00:00Z" }, { game_id: "B", kickoff_utc: "2026-10-04T20:25:00Z" }, { game_id: "C", kickoff_utc: "2026-10-05T00:20:00Z" }, { game_id: "D", kickoff_utc: "2026-10-06T00:15:00Z" }];
  const books = { A: { books: { fanduel: { fetched_at: "2026-10-04T14:45:00Z" } } }, B: { books: { fanduel: { fetched_at: "2026-10-04T14:20:00Z" } } }, C: { books: { fanduel: { fetched_at: "2026-10-04T14:30:00Z" } } } };
  assert.deepEqual(pickFanduelGames(games, books, now, 3).map((g) => g.game_id), ["D", "A", "B"], "D was never fetched; A kicks off in 2 hours so its 15 minutes weigh as 45; B is 40 minutes old");
});

// ---------- the refresh end to end, with a fake provider ----------
const fakeProvider = (all) => async (url) => {
  const book = url.searchParams.get("sportsbook"), event = url.searchParams.get("event_id"), wanted = url.searchParams.get("market").split(",");
  assert.equal(url.searchParams.get("is_main_line"), null, "the is_main_line filter is never sent");
  assert.equal(url.searchParams.get("league"), "nfl");
  const list = all.filter((r) => r.sportsbook === book && wanted.includes(r.market_type) && (!event || r.event_id === event));
  const start = Number(url.searchParams.get("cursor") || 0);
  return page(list.slice(start, start + 200), start + 200 < list.length ? String(start + 200) : null);
};
const baseKv = () => memoryKv({ "nfl:slate:current": slate, "nfl:rosters:current": rosters });

test("the refresh does nothing unless NFL odds are switched on", async () => {
  const kv = baseKv();
  let called = 0;
  const out = await refreshNflOdds({ PROPS_DATA: kv, SHARPAPI_KEY: "k" }, { now: CAPTURE, fetchImpl: async () => { called++; return page([], null); } });
  assert.deepEqual(out, { skipped: "disabled" });
  assert.equal(called, 0, "no request is sent to the provider");
  assert.equal(kv.writes.length, 0);
  assert.deepEqual(await refreshNflOdds({ PROPS_DATA: kv, NFL_ODDS_ENABLED: "true" }, { now: CAPTURE }), { skipped: "no_key" });
});

test("the refresh stores each book's own lines with its fetch time, within the request budget", async () => {
  const kv = baseKv();
  const env = { PROPS_DATA: kv, SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true" };
  const out = await refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) });
  const stored = await kv.get(ODDS_KEY, "json");
  assert.ok(out.runs.reduce((a, r) => a + r.requests, 0) <= ODDS_DEFAULTS.max_requests);
  assert.equal(out.runs[0].sportsbook, "draftkings");
  assert.ok(out.runs.filter((r) => r.sportsbook === "fanduel").length <= ODDS_DEFAULTS.fanduel_games_per_run);
  assert.ok(stored.markets.length > 150);
  assert.ok(!stored.markets.some((m) => m.game_id === "2026_04_PIT_CLE"), "the game in progress is absent");
  const m = stored.markets.find((x) => x.player_name === "Terry McLaurin" && x.prop_type === "rec_yds");
  assert.deepEqual(m.books.map((b) => [b.sportsbook, b.main.line]), [["draftkings", 51.5], ["fanduel", 50.5]]);
  for (const b of m.books) assert.equal(b.fetched_at, new Date(CAPTURE).toISOString());
  assert.equal(stored.games["2026_04_IND_WAS"].books.fanduel.fetched_at, new Date(CAPTURE).toISOString());
  assert.deepEqual(stored.freshness_rule, { fresh_minutes: 15, stale_minutes: 30 });
});

test("a book that was not refreshed this run keeps its older fetch time", async () => {
  const kv = baseKv();
  const env = { PROPS_DATA: kv, SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true", NFL_ODDS_FANDUEL_GAMES: "1" };
  await refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) });
  const first = await kv.get(ODDS_KEY, "json");
  const fdGames = Object.entries(first.games).filter(([, g]) => g.books.fanduel).map(([id]) => id);
  assert.equal(fdGames.length, 1, "one FanDuel game per run with this setting");
  const later = CAPTURE + 10 * 60000;
  await refreshNflOdds(env, { now: later, fetchImpl: fakeProvider(rows) });
  const second = await kv.get(ODDS_KEY, "json");
  assert.equal(second.games[fdGames[0]].books.fanduel.fetched_at, new Date(CAPTURE).toISOString(), "the rotation moved on; this game's FanDuel time did not");
  assert.equal(second.games[fdGames[0]].books.draftkings.fetched_at, new Date(later).toISOString(), "DraftKings is refreshed every run");
  const fdEntry = second.markets.flatMap((m) => m.books).find((b) => b.sportsbook === "fanduel" && b.fetched_at === new Date(CAPTURE).toISOString());
  assert.ok(fdEntry, "the older FanDuel prices are kept, carrying their own age");
});

test("unresolved rows are stored for review, not published, and only counts are logged", async () => {
  const kv = baseKv();
  const sample = rows.find((r) => !r.is_live && r.sportsbook === "draftkings" && r.market_type === "player_receiving_yards");
  const ghostRows = [...rows, { ...sample, id: "ghost-over", player_name: "Nobody Realname" }, { ...sample, id: "ghost-under", player_name: "Nobody Realname", selection_type: "under", selection: "Under" }];
  const logs = [];
  const log = console.log, warn = console.warn;
  console.log = (m) => logs.push(String(m)); console.warn = (m) => logs.push(String(m));
  try { await refreshNflOdds({ PROPS_DATA: kv, SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true" }, { now: CAPTURE, fetchImpl: fakeProvider(ghostRows) }); } finally { console.log = log; console.warn = warn; }
  const stored = await kv.get(ODDS_KEY, "json");
  assert.ok(!stored.markets.some((m) => m.player_name === "Nobody Realname" || m.player_id == null));
  assert.equal(stored.counts.unresolved, 2);
  const held = await kv.get(UNRESOLVED_KEY, "json");
  assert.equal(held.count, 2);
  assert.deepEqual(held.by_reason, { no_match: 2 });
  assert.equal(held.rows[0].row.player_name, "Nobody Realname");
  assert.ok(!logs.join("\n").includes("Nobody Realname"), "the log carries counts, not the rows");
  assert.ok(!logs.join("\n").includes("test-key") && !logs.join("\n").includes('"k"'));
});
