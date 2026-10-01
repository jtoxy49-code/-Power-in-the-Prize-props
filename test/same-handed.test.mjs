// Regression test for same-handed starters: a real 0 must stay 0, and a stat
// the MLB API did not report must stay null (missing), never become 0.
// Run with: node --test test/same-handed.test.mjs
// Nothing real is fetched or written: fetch and the KV binding are stubbed.
import test from "node:test";
import assert from "node:assert/strict";
import { getSameHandedStartersVsTeam } from "../src/same-handed.js";

const TEAM = 143;
const schedule = {
  dates: [{
    games: [
      { status: { abstractGameState: "Final" }, officialDate: "2026-09-10", teams: { home: { team: { id: TEAM } }, away: { team: { id: 1 }, probablePitcher: { id: 11, fullName: "Real Zero" } } } },
      { status: { abstractGameState: "Final" }, officialDate: "2026-09-12", teams: { home: { team: { id: 2 }, probablePitcher: { id: 22, fullName: "Missing Stats" } }, away: { team: { id: TEAM } } } },
    ],
  }],
};
const logs = {
  11: [{ date: "2026-09-10", stat: { inningsPitched: "5.0", strikeOuts: 0, baseOnBalls: 0, hits: 3, earnedRuns: 0, numberOfPitches: 80 } }],
  22: [{ date: "2026-09-12", stat: { inningsPitched: "4.0", hits: 2, earnedRuns: 1, strikeOuts: null } }],
};

let calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  let body;
  if (u.includes("/schedule?")) body = schedule;
  else if (u.includes("stats=gameLog")) body = { stats: [{ splits: logs[u.match(/people\/(\d+)\//)[1]] || [] }] };
  else if (u.match(/people\/\d+$/)) body = { people: [{ pitchHand: { code: "L" } }] };
  else throw new Error("unexpected " + u);
  return { ok: true, json: async () => body };
};

const env = (cached = null) => ({ PROPS_DATA: { get: async (k) => (k.startsWith("same-handed:") ? cached : null), put: async () => {} } });

test("a real 0 stays 0 and a missing stat stays null", async () => {
  const rows = await getSameHandedStartersVsTeam(env(), TEAM, "Test Team", "L", true);
  const zero = rows.find((r) => r.pitcher_name === "Real Zero");
  const miss = rows.find((r) => r.pitcher_name === "Missing Stats");
  assert.equal(zero.strikeouts, 0);
  assert.equal(zero.walks, 0);
  assert.equal(zero.earned_runs, 0);
  assert.equal(miss.strikeouts, null, "explicit null");
  assert.equal(miss.walks, null, "absent field");
  assert.equal(miss.pitches_thrown, null, "absent field");
  assert.equal(miss.hits_allowed, 2, "a reported value next to missing ones is kept");
});

test("a list cached before missing stats were kept is refetched; a current one is not", async () => {
  const fresh = new Date().toISOString();
  const cachedRow = { pitcher_name: "Cached", hand: "L", strikeouts: 0 };
  calls = 0;
  const old = await getSameHandedStartersVsTeam(env({ fetched_at: fresh, starters: [cachedRow] }), TEAM, "Test Team", "L");
  assert.ok(calls > 0, "old-format cache is stale");
  assert.ok(!old.some((r) => r.pitcher_name === "Cached"));
  calls = 0;
  const cur = await getSameHandedStartersVsTeam(env({ fetched_at: fresh, starters: [cachedRow], missing_as_null: true }), TEAM, "Test Team", "L");
  assert.equal(calls, 0, "current cache is served without a fetch");
  assert.equal(cur[0].pitcher_name, "Cached");
});
