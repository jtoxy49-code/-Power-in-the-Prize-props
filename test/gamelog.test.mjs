// Regression test for the Worker game log: a real 0 must stay 0, and a stat
// the MLB API did not report must stay null (missing), never become 0.
// Run with: node --test test/
// Nothing real is fetched or written: fetch and the KV binding are stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { getCachedGameLog } from "../src/gamelog.js";

function stubEnv() {
  const puts = [];
  return {
    puts,
    PROPS_DATA: {
      get: async () => null, // no cache: force the cleaning path
      put: async (key, value) => { puts.push({ key, value }); },
    },
  };
}

function stubFetch(splits) {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ stats: [{ splits }] }) });
}

const fullLine = {
  inningsPitched: "6.0", outs: 18, strikeOuts: 0, baseOnBalls: 0, hits: 0,
  earnedRuns: 0, numberOfPitches: 88, battersFaced: 20,
};

test("a real 0 stays 0", async () => {
  stubFetch([{ date: "2026-05-01", opponent: { name: "Kansas City Royals" }, isHome: true, stat: fullLine }]);
  const { games } = await getCachedGameLog(stubEnv(), "1", 2026);
  assert.equal(games[0].strikeouts, 0);
  assert.equal(games[0].walks, 0);
  assert.equal(games[0].hits_allowed, 0);
  assert.equal(games[0].earned_runs, 0);
  assert.equal(games[0].outs, 18);
});

test("a missing stat stays null, not 0", async () => {
  const { strikeOuts, baseOnBalls, ...partial } = fullLine;
  stubFetch([
    { date: "2026-05-01", opponent: { name: "Kansas City Royals" }, isHome: true, stat: partial },
    { date: "2026-05-07", opponent: { name: "Boston Red Sox" }, isHome: false, stat: { ...fullLine, strikeOuts: null, hits: "" } },
    { date: "2026-05-13", opponent: { name: "Detroit Tigers" }, isHome: true },
  ]);
  const { games } = await getCachedGameLog(stubEnv(), "1", 2026);
  assert.equal(games[0].strikeouts, null, "absent field");
  assert.equal(games[0].walks, null, "absent field");
  assert.equal(games[0].hits_allowed, 0, "a reported 0 next to missing fields stays 0");
  assert.equal(games[1].strikeouts, null, "explicit null");
  assert.equal(games[1].hits_allowed, null, "empty string");
  assert.equal(games[2].strikeouts, null, "no stat block at all");
  assert.equal(games[2].pitches_thrown, null);
});

test("numeric strings still parse, and the log stays oldest first", async () => {
  stubFetch([
    { date: "2026-06-10", opponent: { name: "A" }, stat: { ...fullLine, strikeOuts: "9" } },
    { date: "2026-06-01", opponent: { name: "B" }, stat: { ...fullLine, strikeOuts: "11" } },
  ]);
  const { games } = await getCachedGameLog(stubEnv(), "1", 2026);
  assert.deepEqual(games.map((g) => [g.date, g.strikeouts]), [["2026-06-01", 11], ["2026-06-10", 9]]);
});

test("starts and relief appearances are told apart by MLB's gamesStarted", async () => {
  stubFetch([
    { date: "2026-09-20", opponent: { name: "A" }, stat: { ...fullLine, gamesStarted: 1 } },
    { date: "2026-09-27", opponent: { name: "B" }, stat: { ...fullLine, inningsPitched: "1.0", strikeOuts: 0, gamesStarted: 0 } },
    { date: "2026-09-28", opponent: { name: "C" }, stat: { ...fullLine } },
  ]);
  const { games } = await getCachedGameLog(stubEnv(), "1", 2026);
  assert.deepEqual(games.map((g) => g.started), [true, false, null], "start, relief, unknown (never guessed)");
  assert.equal(games[1].strikeouts, 0, "a relief outing's real 0 stays 0");
});

test("a log cached before the start flag existed is refetched, a current one is not", async () => {
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return { ok: true, json: async () => ({ stats: [{ splits: [{ date: "2026-09-20", opponent: { name: "A" }, stat: { ...fullLine, gamesStarted: 1 } }] }] }) }; };
  const fresh = new Date().toISOString();
  // A current cache carries the start flag and the game types it was fetched with.
  const env = (games, extra = {}) => ({ PROPS_DATA: { get: async () => ({ games, fetched_at: fresh, ...extra }), put: async () => {} } });
  const old = await getCachedGameLog(env([{ date: "2026-09-20", strikeouts: 6 }]), "1", 2026);
  assert.equal(fetched, 1, "old-format cache is stale");
  assert.equal(old.games[0].started, true);
  await getCachedGameLog(env([{ date: "2026-09-20", strikeouts: 6, started: true }], { game_types: "R,F,D,L,W" }), "1", 2026);
  assert.equal(fetched, 1, "current cache is served without a fetch");
});
