// Regression tests for postseason game logs: regular season + every postseason
// round in one chronological log, each game once, true starts preserved, relief
// left out of starts, missing vs real 0 preserved, and samples that cross into
// the postseason. Nothing real is fetched or written: fetch and KV are stubbed.
// Run with: node --test test/postseason.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { getCachedGameLog, GAME_TYPES } from "../src/gamelog.js";
import { startsOf, gamesForSample, hitRate, postseasonCount, postseasonRound } from "../public/assets/js/domain.js";

const line = (k, gs = 1) => ({ inningsPitched: "6.0", outs: 18, strikeOuts: k, baseOnBalls: 1, hits: 4, earnedRuns: 2, numberOfPitches: 95, battersFaced: 24, gamesStarted: gs });
const split = (date, pk, gameType, opp, stat) => ({ date, game: { gamePk: pk, gameNumber: 1 }, gameType, opponent: { name: opp }, isHome: true, stat });

let lastUrl = "";
function stub(splits) {
  globalThis.fetch = async (url) => { lastUrl = String(url); return { ok: true, json: async () => ({ stats: [{ splits }] }) }; };
}
const env = (cached = null) => ({ PROPS_DATA: { get: async () => cached, put: async () => {} } });

// Twelve regular-season starts, then a Wild Card start, a Division Series relief
// outing, and a Division Series start against the same club.
const regular = Array.from({ length: 12 }, (_, i) => split(`2026-08-${String(i + 1).padStart(2, "0")}`, 1000 + i, "R", i % 3 ? "Chicago Cubs" : "Philadelphia Phillies", line(5 + (i % 4))));
const post = [
  split("2026-09-29", 2001, "F", "Philadelphia Phillies", line(9)),
  split("2026-10-03", 2002, "D", "Los Angeles Dodgers", line(1, 0)), // relief
  split("2026-10-06", 2003, "D", "Los Angeles Dodgers", { ...line(0), baseOnBalls: null }), // real 0 K, missing walks
];

test("the log asks MLB for the regular season and every postseason round", async () => {
  stub(regular);
  await getCachedGameLog(env(), "1", 2026);
  assert.match(lastUrl, /gameType=R,F,D,L,W/);
  assert.equal(GAME_TYPES, "R,F,D,L,W");
});

test("regular-season-only pitcher: nothing marked postseason", async () => {
  stub(regular);
  const { games } = await getCachedGameLog(env(), "1", 2026);
  assert.equal(games.length, 12);
  assert.equal(postseasonCount(games), 0);
  assert.ok(games.every((g) => g.game_type === "R" && g.postseason === false));
});

test("postseason games join the log in date order, each game once", async () => {
  stub([...post.slice().reverse(), ...regular, post[0]]); // out of order, Wild Card start listed twice
  const { games } = await getCachedGameLog(env(), "1", 2026);
  assert.equal(games.length, 15);
  assert.deepEqual(games.slice(-3).map((g) => [g.date, g.game_type, g.postseason]), [["2026-09-29", "F", true], ["2026-10-03", "D", true], ["2026-10-06", "D", true]]);
  assert.equal(postseasonRound(games.at(-3)).short, "WC");
  assert.equal(postseasonRound(games.at(-1)).long, "Division Series");
});

test("a postseason relief outing is never a start; true starts keep their flag", async () => {
  stub([...regular, ...post]);
  const { games } = await getCachedGameLog(env(), "1", 2026);
  const { games: starts, leftOut } = startsOf(games);
  assert.equal(starts.length, 14);
  assert.deepEqual(leftOut.map((g) => g.date), ["2026-10-03"]);
});

test("L10 crosses from the regular season into the postseason; Season includes the postseason", async () => {
  stub([...regular, ...post]);
  const { games } = await getCachedGameLog(env(), "1", 2026);
  const starts = startsOf(games).games;
  const l10 = gamesForSample(starts, "L10", null);
  assert.equal(l10.length, 10);
  assert.equal(l10.at(-1).date, "2026-10-06");
  assert.equal(postseasonCount(l10), 2);
  assert.equal(postseasonCount(gamesForSample(starts, "season", null)), 2);
});

test("H2H includes a postseason meeting with the same club", async () => {
  stub([...regular, ...post]);
  const { games } = await getCachedGameLog(env(), "1", 2026);
  const h2h = gamesForSample(startsOf(games).games, "H2H", "Philadelphia Phillies");
  assert.equal(h2h.length, 5);
  assert.equal(h2h.at(-1).game_type, "F");
});

test("in the postseason a real 0 stays 0 and a missing stat stays missing", async () => {
  stub([...regular, ...post]);
  const { games } = await getCachedGameLog(env(), "1", 2026);
  const last = games.at(-1);
  assert.equal(last.strikeouts, 0);
  assert.equal(last.walks, null);
  const r = hitRate([last], "walks", 1.5, "Over");
  assert.deepEqual([r.n, r.missing], [0, 1]);
  assert.equal(hitRate([last], "strikeouts", 0.5, "Under").hits, 1);
});

test("a log cached before the postseason was included is refetched", async () => {
  stub([...regular, ...post]);
  const old = { player_id: "1", games: regular.map((s) => ({ date: s.date, started: true })), fetched_at: new Date().toISOString() };
  const { games } = await getCachedGameLog(env(old), "1", 2026);
  assert.equal(games.length, 15);
  const fresh = { player_id: "1", game_types: GAME_TYPES, games: [{ date: "2026-08-01", started: true }], fetched_at: new Date().toISOString() };
  assert.equal((await getCachedGameLog(env(fresh), "1", 2026)).games.length, 1);
});
