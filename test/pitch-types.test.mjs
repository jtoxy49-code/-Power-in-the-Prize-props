// Regression tests for pitch-type stats: a real 0 from Savant must stay 0, a
// blank must stay null (missing), and averages must leave missing values out
// instead of counting them as zero.
// Run with: node --test test/pitch-types.test.mjs
// Nothing real is fetched or written: the KV binding is an in-memory stub.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanRow as cleanBatterRow, getTeamPitchTypeSplits, getBatterPitchTypes } from "../src/batter-pitch-types.js";
import { cleanRow as cleanPitcherRow } from "../src/pitch-arsenal.js";

const raw = (over) => ({
  player_id: "1", "last_name, first_name": "Test, Hitter", pitch_type: "SL", pitch_name: "Slider",
  pitch_usage: "", pitches: "40", pa: "12", ba: "0", est_ba: "0.105", slg: "0", est_slg: "", woba: "", est_woba: "",
  whiff_percent: "0", k_percent: "", put_away: "", hard_hit_percent: "",
  ...over,
});

for (const [label, clean] of [["batter", cleanBatterRow], ["pitcher", cleanPitcherRow]]) {
  test(`${label} rows keep a real zero and leave blanks missing`, () => {
    const r = clean(raw());
    assert.equal(r.ba, 0);
    assert.equal(r.whiff_pct, 0);
    assert.equal(r.slg, 0);
    assert.equal(r.est_ba, 0.105);
    assert.equal(r.k_pct, null);
    assert.equal(r.est_slg, null);
    assert.equal(r.usage_pct, null);
    assert.equal(r.pa, 12);
    assert.equal(r.pitches, 40);
  });
}

function kv(store) {
  return { PROPS_DATA: { get: async (key) => store[key] ?? null } };
}

const rows = [
  // A real 0% whiff on 10 PA, and a hitter whose whiff rate was not reported.
  { player_id: "1", pitch_type: "SL", pitch_name: "Slider", pa: 10, pitches: 40, est_ba: 0.2, ba: 0.2, k_pct: 10, whiff_pct: 0 },
  { player_id: "2", pitch_type: "SL", pitch_name: "Slider", pa: 30, pitches: 100, est_ba: 0.3, ba: null, k_pct: 30, whiff_pct: null },
  { player_id: "3", pitch_type: "SL", pitch_name: "Slider", pa: 20, pitches: 60, est_ba: null, ba: 0.25, k_pct: 20, whiff_pct: 40 },
  { player_id: "1", pitch_type: "FF", pitch_name: "4-Seam Fastball", pa: 50, pitches: 200, est_ba: 0.25, ba: 0.24, k_pct: 22, whiff_pct: 20 },
];

test("team averages leave missing values out of each metric", async () => {
  const env = kv({
    "stats:batter_pitch_types": { rows },
    "stats:batters_merged": { by_team: { Team: [{ player_id: "1" }, { player_id: "2" }, { player_id: "3" }] } },
  });
  const sl = (await getTeamPitchTypeSplits(env, "Team")).find((p) => p.pitch_type === "SL");
  assert.equal(sl.pa, 60);
  // whiff: (0*10 + 40*20) / (10 + 20) = 26.7 — hitter 2 (missing) is not a zero
  assert.equal(sl.whiff_pct, 26.7);
  // xBA: (0.2*10 + 0.3*30) / 40 = 0.275 — hitter 3 (missing) is left out
  assert.equal(sl.est_ba, 0.275);
  // K%: everyone reported: (10*10 + 30*30 + 20*20) / 60 = 23.3
  assert.equal(sl.k_pct, 23.3);
});

test("per-hitter rows come back only for the requested ids, with null-aware MLB benchmarks", async () => {
  const env = kv({ "stats:batter_pitch_types": { rows, updated_at: "2026-09-28T06:00:00Z" } });
  const d = await getBatterPitchTypes(env, ["1", "999"]);
  assert.deepEqual(Object.keys(d.batters), ["1"]);
  assert.equal(d.batters["1"].length, 2);
  assert.equal(d.batters["1"].find((r) => r.pitch_type === "SL").whiff_pct, 0);
  // Whiff benchmark is weighted by pitches seen, without the missing value:
  // (0*40 + 40*60) / (40 + 60) = 24
  assert.equal(d.league.SL.whiff_pct, 24);
  // xBA benchmark weighted by PA, without the missing value: 0.275
  assert.equal(d.league.SL.est_ba, 0.275);
  assert.equal(d.league.SL.pa, 60);
  assert.equal(d.updated_at, "2026-09-28T06:00:00Z");
});
