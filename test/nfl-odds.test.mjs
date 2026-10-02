// NFL odds: main-line selection, FanDuel's ladder, book-specific lines,
// freshness, live and suspended rows, duplicates, player quarantine, and
// cursor-expiry recovery. Runs on the synthetic feed (real players and games,
// made-up prices, the structure the 2026-10-02 probe observed). The real capture
// is checked separately in nfl-odds-capture.test.mjs when it is on the machine.
import test from "node:test";
import assert from "node:assert/strict";
import { loadOddsRows, derive, memoryKv } from "./fixtures/nfl/load.mjs";
import { impliedProbability, selectMainLine, freshness, bestPrices, normalizeOddsRows, buildBookMarkets, mergeMarkets, FRESHNESS } from "../src/nfl/odds-rules.js";
import { sweepOdds, completeEvents, pickFanduelGames, refreshNflOdds, ODDS_KEY, UNRESOLVED_KEY, PROP_ORDER, ODDS_DEFAULTS } from "../src/nfl/odds.js";
import { handleNflApi } from "../src/nfl/api.js";
import { localD1 } from "../etl/nfl/local-d1.mjs";
import { cadenceReport } from "../scripts/nfl-odds-cadence.mjs";
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

// The two provider behaviors that break a naive reading of the feed must stay
// in the synthetic rows themselves, so these checks read the raw rows, before
// any of the pipeline's own rules have run.
test("the synthetic feed keeps the provider's failure cases: a wrong FanDuel main flag and over-only ladders", () => {
  const groups = new Map();
  for (const r of rows.filter((x) => x.sportsbook === "fanduel" && !x.is_live && V1_MARKET_TYPES.includes(x.market_type))) {
    const k = `${r.event_id}|${r.player_name}|${r.market_type}`;
    if (!groups.has(k)) groups.set(k, { market: r.market_type, lines: new Map() });
    const lines = groups.get(k).lines;
    if (!lines.has(r.line)) lines.set(r.line, { sides: new Set(), flagged: false });
    lines.get(r.line).sides.add(r.selection_type);
    if (r.is_main_line) lines.get(r.line).flagged = true;
  }
  assert.ok(groups.size >= 20, "FanDuel markets are present");
  let wrongFlag = 0, rungs = 0;
  for (const g of groups.values()) {
    const all = [...g.lines.values()];
    const twoSided = all.filter((l) => l.sides.has("over") && l.sides.has("under"));
    const overOnly = all.filter((l) => l.sides.has("over") && !l.sides.has("under"));
    assert.equal(twoSided.length, 1, "exactly one line carries both prices");
    assert.ok(overOnly.length >= 6, "the rest is an over-only ladder");
    assert.equal(all.filter((l) => l.sides.has("under") && !l.sides.has("over")).length, 0);
    assert.equal(all.filter((l) => l.flagged).length, 1, "the provider flags exactly one line as main");
    rungs += overOnly.length;
    if (overOnly.some((l) => l.flagged)) { wrongFlag++; assert.equal(twoSided[0].flagged, false); assert.notEqual(g.market, "player_receptions", "the wrong flag is a yardage behavior"); }
  }
  assert.ok(wrongFlag >= 5, `the main flag sits on an over-only rung in ${wrongFlag} FanDuel markets`);
  assert.ok(wrongFlag < groups.size, "and is right in the others, so a rule that trusts it fails only some of the time");
  assert.ok(rungs > 200);
  // what trusting the flag would have published: an over-only line as a main line
  const trusting = [...groups.values()].filter((g) => [...g.lines.values()].some((l) => l.flagged && !l.sides.has("under"))).length;
  assert.equal(trusting, wrongFlag);
});

test("a FanDuel market that is only an over-only ladder gets no main line, and no rung is promoted", () => {
  const mclaurin = byBook("fanduel").filter((o) => o.player_name === "Terry McLaurin" && o.prop_type === "rec_yds");
  const ladderOnly = mclaurin.filter((o) => o.line !== 50.5);
  assert.ok(ladderOnly.length >= 12 && ladderOnly.every((o) => o.side === "over"));
  assert.ok(ladderOnly.some((o) => o.provider_main), "the provider's main flag is still on the 49.5 rung");
  const { entries, implausible } = buildBookMarkets(ladderOnly, "2026-10-02T03:07:00.000Z");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].book.main, null, "a flagged over-only rung is not a main line");
  assert.equal(entries[0].book.provider_flagged_line, 49.5);
  assert.equal(entries[0].book.ladder.length, ladderOnly.length, "the ladder is kept as a ladder");
  assert.equal(implausible.length, 0);
  // beside DraftKings, the market shows DraftKings' line alone; nothing from the ladder is priced against it
  const dkOffers = byBook("draftkings").filter((o) => o.player_name === "Terry McLaurin" && o.prop_type === "rec_yds");
  const merged = mergeMarkets([...buildBookMarkets(dkOffers, "2026-10-02T03:07:00.000Z").entries, ...entries]);
  const best = bestPrices({ books: merged[0].books }, CAPTURE);
  assert.deepEqual(best.lines.map((l) => l.line), [51.5]);
  assert.deepEqual(best.lines[0].books.map((b) => b.sportsbook), ["draftkings"]);
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
// the run ledger in a real SQLite engine, with the project's migration applied
const envOf = async (kv, extra = {}) => ({ PROPS_DATA: kv, NFL_DB: await localD1({ only: ["0002_nfl_odds_runs.sql"] }), SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true", ...extra });
const ledger = async (env) => (await env.NFL_DB.prepare("SELECT * FROM nfl_odds_runs ORDER BY started_at, kind, run_id").all()).results.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null }));
const at = (m) => CAPTURE + m * 60000;
const isoAt = (m) => new Date(at(m)).toISOString();
const quietly = async (fn) => { const log = console.log, warn = console.warn; const lines = []; console.log = (m) => lines.push(String(m)); console.warn = (m) => lines.push(String(m)); try { return { out: await fn(), lines }; } finally { console.log = log; console.warn = warn; } };

test("the refresh does nothing unless NFL odds are switched on, and nothing without its run ledger", async () => {
  const kv = baseKv();
  let called = 0;
  const fetchImpl = async () => { called++; return page([], null); };
  const env = await envOf(kv, { NFL_ODDS_ENABLED: undefined });
  assert.deepEqual(await refreshNflOdds(env, { now: CAPTURE, fetchImpl }), { skipped: "disabled" });
  assert.deepEqual(await refreshNflOdds({ ...env, NFL_ODDS_ENABLED: "true", SHARPAPI_KEY: undefined }, { now: CAPTURE }), { skipped: "no_key" });
  assert.deepEqual(await refreshNflOdds({ ...env, NFL_ODDS_ENABLED: "true", NFL_DB: undefined }, { now: CAPTURE, fetchImpl }), { skipped: "no_run_ledger" }, "without the lock there is no provider call");
  assert.equal(called, 0, "no request is sent to the provider");
  assert.equal(kv.writes.length, 0);
  assert.deepEqual(await ledger(env), [], "and while it is off nothing is written to D1 either");
});

test("the refresh stores each book's own lines with its fetch time, within the request budget, and records the run", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  const { out } = await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const stored = await kv.get(ODDS_KEY, "json");
  assert.ok(out.runs.reduce((a, r) => a + r.requests, 0) <= ODDS_DEFAULTS.max_requests);
  assert.equal(out.runs[0].sportsbook, "draftkings");
  assert.ok(out.runs.filter((r) => r.sportsbook === "fanduel").length <= ODDS_DEFAULTS.fanduel_games_per_run);
  assert.ok(stored.markets.length > 150);
  assert.ok(!stored.markets.some((m) => m.game_id === "2026_04_PIT_CLE"), "the game in progress is absent");
  const m = stored.markets.find((x) => x.player_name === "Terry McLaurin" && x.prop_type === "rec_yds");
  assert.deepEqual(m.books.map((b) => [b.sportsbook, b.main.line]), [["draftkings", 51.5], ["fanduel", 50.5]]);
  for (const b of m.books) {
    assert.equal(b.fetched_at, new Date(CAPTURE).toISOString());
    assert.equal(b.seen_at, "2026-10-02T03:05:59.555Z", "the provider's own timestamp is kept beside ours, not in place of it");
  }
  assert.equal(stored.games["2026_04_IND_WAS"].books.fanduel.fetched_at, new Date(CAPTURE).toISOString());
  assert.deepEqual(stored.freshness_rule, { fresh_minutes: 15, stale_minutes: 30 });

  const [run] = await ledger(env);
  assert.equal(run.kind, "attempt");
  assert.equal(run.outcome, "success");
  assert.equal(run.started_at, new Date(CAPTURE).toISOString());
  assert.equal(run.requests, out.runs.reduce((a, r) => a + r.requests, 0));
  assert.equal(run.detail.stored, true);
  assert.equal(run.detail.pregame_games.length, 15);
  assert.equal(run.detail.fanduel_planned.length, 3);
  const game = run.detail.sweeps[0].games["2026_04_IND_WAS"];
  assert.equal(game.length, 4, "one entry per V1 prop");
  assert.ok(game.every(([n, seen]) => n > 0 && !Number.isNaN(Date.parse(seen))), "markets with a main line, and the provider's newest timestamp");
  assert.ok(!run.detail.sweeps.some((s) => "2026_04_PIT_CLE" in s.games), "a game that has started is not a retrieval");
});

test("a book that was not refreshed this run keeps its older fetch time", async () => {
  const kv = baseKv();
  const env = await envOf(kv, { NFL_ODDS_FANDUEL_GAMES: "1" });
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const first = await kv.get(ODDS_KEY, "json");
  const fdGames = Object.entries(first.games).filter(([, g]) => g.books.fanduel).map(([id]) => id);
  assert.equal(fdGames.length, 1, "one FanDuel game per run with this setting");
  const later = CAPTURE + 10 * 60000;
  await quietly(() => refreshNflOdds(env, { now: later, fetchImpl: fakeProvider(rows) }));
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
  const env = await envOf(kv);
  const { lines } = await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(ghostRows) }));
  const stored = await kv.get(ODDS_KEY, "json");
  assert.ok(!stored.markets.some((m) => m.player_name === "Nobody Realname" || m.player_id == null));
  assert.equal(stored.counts.unresolved, 2);
  const held = await kv.get(UNRESOLVED_KEY, "json");
  assert.equal(held.count, 2);
  assert.deepEqual(held.by_reason, { no_match: 2 });
  assert.equal(held.rows[0].row.player_name, "Nobody Realname");
  assert.ok(!lines.join("\n").includes("Nobody Realname"), "the log carries counts, not the rows");
  assert.ok(!lines.join("\n").includes("test-key") && !lines.join("\n").includes('"k"'));
  assert.ok(!JSON.stringify(await ledger(env)).includes("Nobody Realname"), "nor does the run ledger");
});

// ---------- the shared allowance ----------
test("the sweep stops before spending the provider's last requests of the minute", async () => {
  const pages = chunk(dk, 100);
  let calls = 0;
  const fetchImpl = async (url) => {
    const c = url.searchParams.get("cursor"); const i = c ? Number(c) : 0; calls++;
    return { ...page(pages[i], String(i + 1)), headers: new Map([["x-ratelimit-remaining", String(3 - calls)]]) };
  };
  const budget = { left: 9 };
  const out = await sweepOdds({ key: "k", params: {}, budget, fetchImpl });
  assert.equal(out.stopped, "provider_rate_limit_near");
  assert.equal(out.requests, 2, "the second response said one request was left, so the sweep stopped there");
  assert.equal(out.rows.length, 200, "the rows already read are kept");
  assert.equal(budget.left, 0, "and nothing else is sent in this run");
});

test("a sweep that finishes with the provider's allowance at its reserve leaves nothing for the next sweep", async () => {
  const kv = baseKv();
  const provider = fakeProvider(rows);
  // the provider reports plenty left until DraftKings' last page, then one
  const fetchImpl = async (url) => { const body = await (await provider(url)).json(); return { ok: true, status: 200, json: async () => body, headers: new Map([["x-ratelimit-remaining", body.pagination.has_more ? "8" : "1"]]) }; };
  const env = await envOf(kv);
  const { out } = await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl }));
  assert.deepEqual(out.runs.map((r) => r.sportsbook), ["draftkings"], "no FanDuel request was sent");
  assert.equal(out.runs[0].complete, true, "the DraftKings sweep itself finished and is stored");
  const stored = await kv.get(ODDS_KEY, "json");
  assert.equal(stored.provider_requests_left, 1, "the header is recorded even when it arrives on the last page");
  assert.ok(stored.markets.length > 150);
  assert.equal((await ledger(env))[0].provider_requests_left, 1);
});

test("a provider that is failing is not asked again in the same run: a 429, a timeout or a network error ends the run", async () => {
  for (const [name, fail, reason] of [
    ["429", async () => ({ ok: false, status: 429, json: async () => ({}) }), "rate_limited"],
    ["timeout", async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }, "timeout"],
    ["network", async () => { throw new TypeError("fetch failed"); }, "network_error"],
    ["500", async () => ({ ok: false, status: 500, json: async () => ({}) }), "http_500"],
  ]) {
    let calls = 0;
    const budget = { left: 9 };
    const out = await sweepOdds({ key: "k", params: {}, budget, fetchImpl: async () => { calls++; return fail(); } });
    assert.equal(out.stopped, reason, name);
    assert.equal(out.complete, false);
    assert.equal(calls, 1, `${name}: one request, no retry`);
    assert.equal(budget.left, 0, `${name}: the rest of the run's budget is given up`);
  }
});

// ---------- overlap: the lock ----------
test("what the guard records, and when: an attempt row in D1, at the run's start time, before the first provider request", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  const provider = fakeProvider(rows);
  let atFirstRequest = null;
  const fetchImpl = async (url) => { if (!atFirstRequest) atFirstRequest = await ledger(env); return provider(url); };
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl }));
  assert.equal(atFirstRequest.length, 1);
  assert.deepEqual([atFirstRequest[0].kind, atFirstRequest[0].outcome, atFirstRequest[0].started_at, atFirstRequest[0].finished_at], ["attempt", "started", new Date(CAPTURE).toISOString(), null]);
  const after = await ledger(env);
  assert.equal(after.length, 1);
  assert.equal(after[0].outcome, "success", "the same row is completed when the run ends");
  assert.ok(after[0].finished_at);
});

test("two invocations starting at the same moment: exactly one calls the provider", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  const provider = fakeProvider(rows);
  // both invocations are parked on their first KV read and released together, so both arrive at the claim having seen the same stored state
  let release;
  const gate = new Promise((r) => { release = r; });
  const parked = { get: async (k, t) => { await gate; return kv.get(k, t); }, put: (k, v) => kv.put(k, v) };
  const callers = [0, 0];
  const run = (i) => refreshNflOdds({ ...env, PROPS_DATA: parked }, { now: CAPTURE, fetchImpl: async (url) => { callers[i]++; return provider(url); } });
  const both = quietly(() => Promise.all([run(0), run(1)]));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(kv.store.has(ODDS_KEY), false, "neither has stored anything: a timestamp read from KV would tell both to go ahead");
  release();
  const { out } = await both;
  assert.equal(out.filter((o) => o.skipped === "too_soon").length, 1, "one is refused");
  assert.equal(out.filter((o) => o.markets > 150).length, 1, "one runs");
  assert.equal(callers.filter((n) => n > 0).length, 1, "only one of them sent anything to the provider");
  assert.ok(Math.max(...callers) <= ODDS_DEFAULTS.max_requests, "one run's worth of requests in total");
  const rowsNow = await ledger(env);
  assert.deepEqual(rowsNow.map((r) => `${r.kind}:${r.outcome}:${r.reason ?? ""}`).sort(), ["attempt:success:", "skip:skipped:too_soon"]);
  assert.equal(kv.writes.filter((k) => k === ODDS_KEY).length, 1, "and the stored odds were written once");
});

test("five at once, and stragglers inside the interval: still one attempt until the interval has passed", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  let calls = 0;
  const provider = fakeProvider(rows);
  const fetchImpl = async (url) => { calls++; return provider(url); };
  const { out } = await quietly(() => Promise.all([0, 0, 0, 0, 0].map(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl }))));
  assert.equal(out.filter((o) => o.skipped === "too_soon").length, 4);
  const one = calls;
  for (const seconds of [1, 60, 299]) assert.deepEqual((await quietly(() => refreshNflOdds(env, { now: CAPTURE + seconds * 1000, fetchImpl }))).out, { skipped: "too_soon" }, `${seconds}s after the attempt started`);
  assert.equal(calls, one, "none of them sent a request");
  const next = (await quietly(() => refreshNflOdds(env, { now: at(10), fetchImpl }))).out;
  assert.ok(next.markets > 150 && calls > one, "the next scheduled run goes ahead");
  assert.equal((await ledger(env)).filter((r) => r.kind === "attempt").length, 2);
});

test("if the ledger cannot be reached, nothing is requested", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  let calls = 0;
  const down = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: network connection lost"); } }) }) };
  const { out, lines } = await quietly(() => refreshNflOdds({ ...env, NFL_DB: down }, { now: CAPTURE, fetchImpl: async () => { calls++; return page([], null); } }));
  assert.deepEqual(out, { skipped: "run_ledger_unavailable" });
  assert.equal(calls, 0);
  assert.equal(kv.writes.length, 0);
  assert.ok(lines.some((l) => /run ledger could not be reached/.test(l)));
});

// ---------- a run that fails part of the way ----------
test("a run cut off by the provider part of the way stores what it retrieved completely and moves no other time", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const before = await kv.get(ODDS_KEY, "json");
  // ten minutes later DraftKings answers, then the first FanDuel request fails
  const provider = fakeProvider(rows);
  const fetchImpl = async (url) => { if (url.searchParams.get("sportsbook") === "fanduel") throw new TypeError("fetch failed"); return provider(url); };
  const { out } = await quietly(() => refreshNflOdds(env, { now: at(10), fetchImpl }));
  assert.equal(out.outcome, "partial");
  assert.equal(out.runs.filter((r) => r.sportsbook === "fanduel").length, 1, "one FanDuel request, then the run stopped");
  const after = await kv.get(ODDS_KEY, "json");
  for (const [id, g] of Object.entries(after.games)) {
    assert.equal(g.books.draftkings.fetched_at, isoAt(10), "DraftKings was retrieved for every game");
    assert.equal(g.books.fanduel?.fetched_at, before.games[id].books.fanduel?.fetched_at, `${id}: FanDuel's time did not move`);
  }
  const fdBefore = before.markets.flatMap((m) => m.books.filter((b) => b.sportsbook === "fanduel").map((b) => [m.market_id, b.fetched_at, b.main?.line]));
  const fdAfter = after.markets.flatMap((m) => m.books.filter((b) => b.sportsbook === "fanduel").map((b) => [m.market_id, b.fetched_at, b.main?.line]));
  assert.deepEqual(fdAfter, fdBefore, "the FanDuel prices are the ones stored before, with the fetch time they had");
  const last = (await ledger(env)).at(-1);
  assert.deepEqual([last.outcome, last.reason], ["partial", "fanduel: network_error"]);
});

test("a run that retrieves nothing writes nothing: the stored odds, their fetch times and updated_at stay as they were", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const before = kv.store.get(ODDS_KEY), writes = kv.writes.length;
  let calls = 0;
  const { out } = await quietly(() => refreshNflOdds(env, { now: at(10), fetchImpl: async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; } }));
  assert.equal(out.failed, "rate_limited");
  assert.equal(calls, 1, "one request; the FanDuel rotation was not attempted after a 429");
  assert.equal(kv.store.get(ODDS_KEY), before, "byte for byte");
  assert.equal(kv.writes.length, writes, "no KV write of any kind");
  assert.equal(JSON.parse(before).updated_at, new Date(CAPTURE).toISOString());
  const last = (await ledger(env)).at(-1);
  assert.deepEqual([last.kind, last.outcome, last.reason, last.requests, last.detail.stored], ["attempt", "failed", "rate_limited", 1, false]);
  // and the API ages what is stored instead of presenting it as current
  const url = new URL("https://pwr-props.com/api/nfl/odds");
  const body = await (await handleNflApi(new Request(url), env, url, at(45))).json();
  assert.ok(body.markets.length > 100);
  assert.ok(body.markets.every((m) => m.books.every((b) => b.status === "stale" && b.age_minutes === 45)), "45 minutes after the last retrieval every price is labeled stale");
  assert.ok(body.markets.every((m) => m.best.lines.every((l) => l.best_over == null && l.best_under == null)), "and none is offered as a best price");
});

test("a run that throws part of the way is recorded as failed, leaves the stored odds alone, and still holds the interval", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const before = kv.store.get(ODDS_KEY);
  const failing = { get: (k, t) => kv.get(k, t), put: async (k, v) => { if (k === ODDS_KEY) throw new Error("KV PUT failed: 500 Internal Server Error"); return kv.put(k, v); } };
  let calls = 0;
  const provider = fakeProvider(rows);
  const fetchImpl = async (url) => { calls++; return provider(url); };
  await assert.rejects(quietly(() => refreshNflOdds({ ...env, PROPS_DATA: failing }, { now: at(10), fetchImpl })), /KV PUT failed/);
  assert.equal(kv.store.get(ODDS_KEY), before, "nothing was stored");
  const failed = (await ledger(env)).at(-1);
  assert.deepEqual([failed.outcome, failed.reason, failed.detail.stored], ["failed", "error: KV PUT failed: 500 Internal Server Error", false]);
  assert.ok(failed.requests > 0, "the requests it had spent are on the record");
  // a retry a minute later is refused: the failed attempt started inside the interval
  const spent = calls;
  assert.deepEqual((await quietly(() => refreshNflOdds(env, { now: at(11), fetchImpl }))).out, { skipped: "too_soon" });
  assert.equal(calls, spent);
  // the next scheduled run goes ahead and repairs the stored odds
  const next = (await quietly(() => refreshNflOdds(env, { now: at(20), fetchImpl }))).out;
  assert.equal(next.outcome, "success");
  assert.equal((await kv.get(ODDS_KEY, "json")).updated_at, isoAt(20));
});

test("a run that is killed leaves its row at 'started', and the interval it claimed still holds", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  // stand-in for a kill: the run can never complete its own row
  const db = env.NFL_DB;
  const noFinish = { prepare: (sql) => (sql.startsWith("UPDATE") ? { bind: () => ({ run: async () => { throw new Error("the invocation is gone"); } }) } : db.prepare(sql)) };
  await quietly(() => refreshNflOdds({ ...env, NFL_DB: noFinish }, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const [row] = await ledger(env);
  assert.deepEqual([row.outcome, row.finished_at, row.detail], ["started", null, null]);
  assert.deepEqual((await quietly(() => refreshNflOdds(env, { now: at(4), fetchImpl: fakeProvider(rows) }))).out, { skipped: "too_soon" });
  assert.equal((await quietly(() => refreshNflOdds(env, { now: at(10), fetchImpl: fakeProvider(rows) }))).out.outcome, "success");
});

// ---------- what fetched_at means ----------
test("partial pagination: games a cut-short sweep did not finish keep their prices and their fetch time", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const { out } = await quietly(() => refreshNflOdds({ ...env, NFL_ODDS_MAX_REQUESTS: "3" }, { now: at(10), fetchImpl: fakeProvider(rows) }));
  assert.deepEqual(out.runs.map((r) => [r.sportsbook, r.complete, r.stopped]), [["draftkings", false, "request_budget"]]);
  assert.equal(out.outcome, "partial");
  const stored = await kv.get(ODDS_KEY, "json");
  const moved = Object.entries(stored.games).filter(([, g]) => g.books.draftkings.fetched_at === isoAt(10)).map(([id]) => id);
  const kept = Object.entries(stored.games).filter(([, g]) => g.books.draftkings.fetched_at === new Date(CAPTURE).toISOString()).map(([id]) => id);
  assert.ok(moved.length >= 5 && kept.length >= 5, `${moved.length} games retrieved completely, ${kept.length} not reached or cut off`);
  assert.equal(moved.length + kept.length, 15);
  for (const m of stored.markets) for (const b of m.books.filter((x) => x.sportsbook === "draftkings")) {
    assert.equal(b.fetched_at, kept.includes(m.game_id) ? new Date(CAPTURE).toISOString() : isoAt(10), `${m.game_id}: a market's time moves only with its game's retrieval`);
  }
  const last = (await ledger(env)).at(-1);
  assert.deepEqual(Object.keys(last.detail.sweeps[0].games).sort(), moved.sort(), "the ledger lists exactly the games that were retrieved");
  assert.equal(last.reason, "draftkings: request_budget");
});

test("a successful empty answer removes the book's lines for that game and stamps the check; a market gone from a retrieved game is removed, not kept", async () => {
  const kv = baseKv();
  const env = await envOf(kv, { NFL_ODDS_FANDUEL_GAMES: "3" });
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const first = await kv.get(ODDS_KEY, "json");
  const tenBal = "2026_04_TEN_BAL", indWas = "2026_04_IND_WAS";
  assert.ok(first.games[tenBal].books.draftkings.markets > 0 && first.games[indWas].books.fanduel.markets > 0);
  const tenBalEvent = first.games[tenBal].event_id;
  // ten minutes later: DraftKings has pulled TEN@BAL entirely, and has suspended Terry McLaurin's receptions
  const changed = rows
    .filter((r) => !(r.sportsbook === "draftkings" && r.event_id === tenBalEvent))
    .map((r) => (r.sportsbook === "draftkings" && r.player_name === "Terry McLaurin" && r.market_type === "player_receptions" ? { ...r, is_active: false } : r));
  await quietly(() => refreshNflOdds(env, { now: at(10), fetchImpl: fakeProvider(changed) }));
  const second = await kv.get(ODDS_KEY, "json");

  assert.deepEqual(second.games[tenBal].books.draftkings, { fetched_at: isoAt(10), markets: 0 }, "the sweep was complete, so 'nothing posted' is an answer and is stamped");
  assert.ok(!second.markets.some((m) => m.game_id === tenBal && m.books.some((b) => b.sportsbook === "draftkings")), "DraftKings' old TEN@BAL lines are gone, not kept with a new time");
  assert.equal(second.games[indWas].books.fanduel.fetched_at, first.games[indWas].books.fanduel.fetched_at, "FanDuel's IND@WAS lines were not retrieved this run and keep their own time");

  const receptions = second.markets.find((m) => m.player_name === "Terry McLaurin" && m.prop_type === "receptions");
  assert.deepEqual(receptions.books.map((b) => [b.sportsbook, b.fetched_at]), [["fanduel", new Date(CAPTURE).toISOString()]], "the suspended DraftKings market is removed; FanDuel's, not retrieved this run, stays with its older time");
  const yards = second.markets.find((m) => m.player_name === "Terry McLaurin" && m.prop_type === "rec_yds");
  assert.equal(yards.books.find((b) => b.sportsbook === "draftkings").fetched_at, isoAt(10));
});

test("a cut-short sweep whose rows are not grouped by game replaces nothing", () => {
  const events = [...new Set(dk.map((r) => r.event_id))];
  assert.deepEqual([...completeEvents(dk, false)], events.slice(0, -1));
  // the first game's last row arrives after the second game's rows
  const first = dk.filter((r) => r.event_id === events[0]), second = dk.filter((r) => r.event_id === events[1]);
  const interleaved = [...first.slice(0, -1), ...second, first.at(-1), ...dk.filter((r) => r.event_id === events[2])];
  assert.deepEqual([...completeEvents(interleaved, false)], [], "the 'all but the last game' rule needs the ordering; without it no game is treated as complete");
  assert.deepEqual([...completeEvents(interleaved, true)].sort(), events.slice(0, 3).sort(), "a complete sweep is complete whatever the order");
});

// ---------- coverage: one game refreshed is one game refreshed ----------
test("the odds route states each book's slate coverage; refreshing one FanDuel game does not make FanDuel's slate fresh", async () => {
  const kv = baseKv();
  const env = await envOf(kv, { NFL_ODDS_FANDUEL_GAMES: "1" });
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const get = async (now) => { const url = new URL("https://pwr-props.com/api/nfl/odds"); return (await handleNflApi(new Request(url), env, url, now)).json(); };
  const soon = await get(at(5));
  assert.deepEqual(soon.coverage.draftkings, { games: 15, fresh: 15, aging: 0, stale: 0, never_fetched: 0, with_lines: 15, oldest_fetched_at: isoAt(0), newest_fetched_at: isoAt(0) });
  assert.deepEqual(soon.coverage.fanduel, { games: 15, fresh: 1, aging: 0, stale: 0, never_fetched: 14, with_lines: soon.coverage.fanduel.with_lines, oldest_fetched_at: isoAt(0), newest_fetched_at: isoAt(0) });
  // three runs later FanDuel has reached three games; the first is already 30 minutes old
  for (const m of [10, 20, 30]) await quietly(() => refreshNflOdds(env, { now: at(m), fetchImpl: fakeProvider(rows) }));
  const later = await get(at(31));
  assert.deepEqual([later.coverage.fanduel.fresh, later.coverage.fanduel.aging, later.coverage.fanduel.stale, later.coverage.fanduel.never_fetched], [2, 1, 1, 11]);
  assert.equal(later.coverage.draftkings.fresh, 15);
  assert.equal(later.updated_at, isoAt(30), "updated_at is the last run that retrieved anything; it is not a statement about FanDuel");
});

test("a stored market for a game that has kicked off is not served as a pregame market", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  const kickoff = Date.parse(slate.games.find((g) => g.game_id === "2026_04_IND_WAS").kickoff_utc);
  const url = new URL("https://pwr-props.com/api/nfl/odds");
  const before = await (await handleNflApi(new Request(url), env, url, kickoff - 60000)).json();
  const after = await (await handleNflApi(new Request(url), env, url, kickoff + 60000)).json();
  assert.ok(before.markets.some((m) => m.game_id === "2026_04_IND_WAS"));
  assert.ok(!after.markets.some((m) => m.game_id === "2026_04_IND_WAS"), "no refresh has run since, the rows are still stored, and they are not served");
  assert.ok(after.markets.length > 0 && after.coverage.draftkings.games < before.coverage.draftkings.games);
});

// ---------- where the odds came from ----------
test("stored odds and the ledger say where the rows came from: 'live' only through the real fetch", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  await quietly(() => refreshNflOdds(env, { now: CAPTURE, fetchImpl: fakeProvider(rows) }));
  assert.equal((await kv.get(ODDS_KEY, "json")).source, "fixture", "an injected provider is never labeled live");
  // called the way the cron calls it, with no fetchImpl; the global fetch is replaced so no network is used
  const real = globalThis.fetch;
  globalThis.fetch = fakeProvider(rows);
  try { await quietly(() => refreshNflOdds(env, { now: at(10) })); } finally { globalThis.fetch = real; }
  assert.equal((await kv.get(ODDS_KEY, "json")).source, "live");
  assert.deepEqual((await ledger(env)).map((r) => r.source), ["fixture", "live"]);
});

// ---------- cadence, measured from the ledger ----------
test("cadence report: attempts by outcome, skips, intervals between completed retrievals, and slate coverage, from live rows only", () => {
  const t = (m) => new Date(Date.parse("2026-10-04T12:00:00Z") + m * 60000).toISOString();
  const lines = (m) => PROP_ORDER.map(() => [5, t(m - 2)]);
  const nothing = PROP_ORDER.map(() => [0, null]);
  const ledgerRows = [];
  for (let m = 0; m <= 120; m += 10) {
    const base = { run_id: `r${m}`, started_at: t(m), finished_at: t(m), kind: "attempt", source: "live" };
    if (m === 60) { // the provider refused the first request: nothing retrieved, nothing stored
      ledgerRows.push({ ...base, outcome: "failed", reason: "rate_limited", requests: 1, provider_requests_left: 0, detail_json: JSON.stringify({ pregame_games: ["A", "B"], fanduel_planned: [], stored: false, sweeps: [{ sportsbook: "draftkings", requests: 1, rows: 0, complete: false, stopped: "rate_limited", games: {} }] }) });
      continue;
    }
    const dkGames = { A: lines(m), B: lines(m) };
    if (m === 50) delete dkGames.B; // that sweep was cut short before game B
    const sweeps = [{ sportsbook: "draftkings", requests: 3, rows: 500, complete: m !== 50, stopped: m === 50 ? "provider_rate_limit_near" : null, games: dkGames }];
    const turn = (m / 10) % 4; // FanDuel rotation: game A every 40 minutes, game B checked and not posted
    if (turn === 0) sweeps.push({ sportsbook: "fanduel", game_id: "A", requests: 1, rows: 60, complete: true, stopped: null, games: { A: lines(m) } });
    if (turn === 1) sweeps.push({ sportsbook: "fanduel", game_id: "B", requests: 1, rows: 0, complete: true, stopped: null, games: { B: nothing } });
    ledgerRows.push({ ...base, outcome: m === 50 ? "partial" : "success", reason: m === 50 ? "draftkings: provider_rate_limit_near" : null, requests: sweeps.reduce((a, s) => a + s.requests, 0), provider_requests_left: 8, detail_json: JSON.stringify({ pregame_games: ["A", "B"], fanduel_planned: [], stored: true, sweeps }) });
  }
  ledgerRows.push({ run_id: "s1", started_at: t(61), finished_at: t(61), kind: "skip", outcome: "skipped", reason: "too_soon", source: "live" });
  // a fixture-built run in the same ledger: FanDuel "posting" game B on every prop
  ledgerRows.push({ run_id: "f1", started_at: t(5), finished_at: t(5), kind: "attempt", outcome: "success", source: "fixture", requests: 1, detail_json: JSON.stringify({ pregame_games: ["A", "B"], stored: true, sweeps: [{ sportsbook: "fanduel", requests: 1, rows: 60, complete: true, stopped: null, games: { A: lines(5), B: lines(5) } }] }) });

  const r = cadenceReport(ledgerRows, { now: t(125) });
  assert.deepEqual(r.rows, { live: 14, not_live_excluded: 1 });
  assert.deepEqual(r.window, { from: t(0), to: t(125), hours: 2.08 });
  assert.deepEqual(r.runs, { attempted: 13, success: 11, partial: 1, failed: 1, never_finished: 0, skipped: 1, skipped_by_reason: { too_soon: 1 } });
  assert.equal(r.last_stored_refresh_at, t(120));
  assert.equal(r.minutes_since_last_stored_refresh, 5);
  assert.deepEqual(r.problems, [{ at: t(50), outcome: "partial", reason: "draftkings: provider_rate_limit_near" }, { at: t(60), outcome: "failed", reason: "rate_limited" }]);
  assert.deepEqual(r.attempt_gap_minutes, { n: 12, median: 10, p90: 10, max: 10 }, "the cron fired every ten minutes ...");
  assert.deepEqual(r.requests_per_attempt, { n: 13, median: 4, p90: 4, max: 4 });
  assert.equal(r.provider_requests_left_min, 0);
  assert.deepEqual(r.sweeps_cut_short, { "draftkings: provider_rate_limit_near": 1, "draftkings: rate_limited": 1 });

  const dkBook = r.books.draftkings;
  assert.deepEqual(dkBook.props.rec_yds.interval_minutes, { n: 21, median: 10, p90: 10, max: 30 }, "... but game B went 30 minutes between retrievals: one cut-short sweep, then one failed run");
  assert.deepEqual(dkBook.games_retrieved_per_attempt, { n: 13, median: 2, p90: 2, max: 2 });
  assert.deepEqual(dkBook.slate_time_share, { fresh: 0.92, aging: 0.08, stale: 0, never_retrieved: 0 });
  assert.deepEqual(dkBook.slate_now, { fresh: 2, aging: 0, stale: 0, never_retrieved: 0, with_lines: 2, newest_age_minutes: 5, oldest_age_minutes: 5 });
  assert.equal(dkBook.props.rec_yds.provider_timestamp_advanced, 1);
  assert.equal(dkBook.props.rec_yds.provider_age_at_fetch_minutes.median, 2);
  assert.equal(dkBook.props.rec_yds.player_markets_now, 10);

  const fd = r.books.fanduel;
  assert.deepEqual(fd.games_retrieved_per_attempt, { n: 13, median: 1, p90: 1, max: 1 }, "one FanDuel game per attempt at most");
  assert.deepEqual(fd.props.rec_yds.interval_minutes, { n: 3, median: 40, p90: 40, max: 40 }, "a 10-minute cron, a 40-minute FanDuel interval");
  assert.deepEqual(fd.slate_time_share, { fresh: 0.38, aging: 0.36, stale: 0.22, never_retrieved: 0.04 }, "over the whole slate and the whole window, FanDuel was fresh 38% of the time");
  assert.deepEqual(fd.slate_now, { fresh: 1, aging: 0, stale: 1, never_retrieved: 0, with_lines: 1, newest_age_minutes: 5, oldest_age_minutes: 35 });
  assert.equal(fd.props.rec_yds.games_with_lines, 1, "the fixture run's game B lines are not counted as live coverage");
  assert.equal(fd.props.rec_yds.retrievals_with_nothing_posted, 3);
  assert.equal(fd.props.rec_yds.player_markets_now, 5);

  // a run that never finished, and a ledger with no live rows at all
  const killed = cadenceReport([...ledgerRows, { run_id: "k1", started_at: t(130), finished_at: null, kind: "attempt", outcome: "started", source: "live", detail_json: null }], { now: t(135) });
  assert.equal(killed.runs.never_finished, 1);
  assert.deepEqual(killed.problems.at(-1), { at: t(130), outcome: "never_finished", reason: null });
  assert.equal(killed.minutes_since_last_stored_refresh, 15, "the age of the stored odds keeps growing through a run that did not finish");
  const none = cadenceReport(ledgerRows.filter((x) => x.source !== "live"));
  assert.deepEqual([none.rows.live, none.rows.not_live_excluded, none.runs.attempted], [0, 1, 0]);
  assert.deepEqual(none.books, {}, "with no live row there is nothing to report about the live feed");
});

test("the report built from the real refresh's own ledger rows: DraftKings covers the slate each run, FanDuel a few games", async () => {
  const kv = baseKv();
  const env = await envOf(kv);
  const real = globalThis.fetch;
  globalThis.fetch = fakeProvider(rows); // stands in for the network, so the rows are labeled the way a cron run labels them
  try { for (const m of [0, 10, 20, 30, 40, 50, 60]) await quietly(() => refreshNflOdds(env, { now: at(m) })); } finally { globalThis.fetch = real; }
  const r = cadenceReport(await ledger(env), { now: isoAt(61) });
  assert.deepEqual([r.runs.attempted, r.runs.success + r.runs.partial, r.runs.failed], [7, 7, 0]);
  assert.equal(r.books.draftkings.slate_games, 15);
  assert.deepEqual(r.books.draftkings.games_retrieved_per_attempt, { n: 7, median: 15, p90: 15, max: 15 });
  assert.equal(r.books.draftkings.slate_now.fresh, 15);
  assert.ok(r.books.fanduel.games_retrieved_per_attempt.max <= 3);
  const fd = r.books.fanduel.slate_now;
  assert.equal(fd.fresh + fd.aging + fd.stale + fd.never_retrieved, 15);
  assert.ok(fd.fresh <= 6 && fd.stale + fd.never_retrieved >= 3, `an hour in, FanDuel: ${JSON.stringify(fd)}`);
  assert.ok(r.books.fanduel.slate_time_share.fresh < 0.5, "and over the hour FanDuel's slate was fresh less than half the time");
});
