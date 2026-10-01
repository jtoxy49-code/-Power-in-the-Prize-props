// Tests for the Lineup Matchups model: columns, the weighted "vs his mix"
// figure, sample and coverage rules, real zeros, edges, rankings, findings.
// Run with: node --test test/matchup-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { pitchColumns, buildMatchup, edgeOf, rankings, findings, weighted, MIN_PA } from "../public/assets/js/matchup-model.js";

const arsenal = [
  { pitch_type: "SL", pitch_name: "Slider", usage_pct: 40, pa: 300, whiff_pct: 38, est_ba: 0.17 },
  { pitch_type: "FF", pitch_name: "4-Seam Fastball", usage_pct: 45, pa: 300, whiff_pct: 25, est_ba: 0.22 },
  { pitch_type: "CH", pitch_name: "Changeup", usage_pct: 12, pa: 100, whiff_pct: 30, est_ba: 0.3 },
  { pitch_type: "CU", pitch_name: "Curveball", usage_pct: 2, pa: 20, whiff_pct: 35, est_ba: 0.2 },
];
const league = {
  FF: { est_ba: 0.25, k_pct: 22, whiff_pct: 22 },
  SL: { est_ba: 0.22, k_pct: 28, whiff_pct: 33 },
  CH: { est_ba: 0.23, k_pct: 24, whiff_pct: 31 },
};
const row = (type, pa, est_ba, k_pct, whiff_pct, pitches = pa * 4) => ({ pitch_type: type, pa, pitches, est_ba, k_pct, whiff_pct });

test("columns: most used first, under 3% left out, weights are shares of his PA", () => {
  const { cols, minor, totalPa } = pitchColumns(arsenal);
  assert.deepEqual(cols.map((c) => c.type), ["FF", "SL", "CH"]);
  assert.deepEqual(minor.map((m) => m.type), ["CU"]);
  assert.equal(totalPa, 720);
  assert.equal(cols[0].share, 300 / 720);
  assert.equal(cols[2].share, 100 / 720);
});

test("weighted xBA = sum(share * xBA) / sum(share), small samples left out", () => {
  const { cols } = pitchColumns(arsenal);
  const cells = { FF: row("FF", 100, 0.3, 20, 20), SL: row("SL", 80, 0.2, 30, 40), CH: row("CH", MIN_PA - 1, 0.5, 10, 10) };
  const w = weighted(cells, cols, "xba");
  // CH has 19 PA: out. (300*.3 + 300*.2) / 600 = .25; coverage 600/720
  assert.ok(Math.abs(w.value - 0.25) < 1e-12);
  assert.ok(Math.abs(w.coverage - 600 / 720) < 1e-12);
  assert.equal(w.ok, true);
});

test("no weighted figure when less than 75% of his PA is covered", () => {
  const { cols } = pitchColumns(arsenal);
  const cells = { FF: row("FF", 100, 0.3, 20, 20), SL: null, CH: row("CH", 40, 0.2, 10, 10) };
  const w = weighted(cells, cols, "xba");
  assert.equal(w.ok, false); // (300 + 100) / 720 = 56%
});

test("a real zero counts; a missing value does not", () => {
  const { cols } = pitchColumns(arsenal);
  const w = weighted({ FF: row("FF", 50, 0, 0, 0), SL: row("SL", 50, 0.2, null, 30), CH: null }, cols, "k");
  // K%: FF real 0 counts, SL missing is left out -> value 0 over coverage 300/720 (not ok)
  assert.equal(w.value, 0);
  assert.equal(w.ok, false);
});

test("Whiff% is never weighted", () => {
  const { cols } = pitchColumns(arsenal);
  assert.equal(weighted({ FF: row("FF", 100, 0.3, 20, 20) }, cols, "whiff"), null);
});

test("edges read from the hitter's side", () => {
  assert.equal(edgeOf(0.3, 0.25, "xba").side, "hitter");
  assert.equal(edgeOf(0.3, 0.25, "xba").strength, "edge");
  assert.equal(edgeOf(0.19, 0.25, "xba").strength, "strong");
  assert.equal(edgeOf(40, 30, "whiff").side, "pitcher");
  assert.equal(edgeOf(22, 22.5, "k").side, "even");
  assert.equal(edgeOf(null, 22, "k"), null);
});

const batters = Array.from({ length: 9 }, (_, i) => ({ order: i + 1, player_id: 100 + i, name: `Hitter ${i + 1}` }));
const rowsById = Object.fromEntries(batters.map((b, i) => [String(b.player_id), [
  row("FF", 120, 0.2 + i * 0.01, 20 + i, 18 + i),
  row("SL", 80, 0.18 + i * 0.01, 25 + i, 30 + i),
  row("CH", 30, 0.25, 22, 28),
]]));

test("rankings: best by highest weighted xBA, toughest by lowest; lowest K% is best", () => {
  const model = buildMatchup({ arsenal, batters, rowsById, league });
  const r = rankings(model, "xba");
  assert.equal(r.best[0].h.name, "Hitter 9");
  assert.equal(r.toughest[0].h.name, "Hitter 1");
  const k = rankings(model, "k");
  assert.equal(k.best[0].h.name, "Hitter 1");
  assert.equal(rankings(model, "whiff"), null);
});

test("rankings need six hitters with a weighted figure", () => {
  const model = buildMatchup({ arsenal, batters: batters.slice(0, 5), rowsById, league });
  assert.equal(rankings(model, "xba").tooFew, true);
});

test("findings are computed from the data and skipped when it is missing", () => {
  const model = buildMatchup({ arsenal, batters, rowsById, league });
  const f = findings(model, { pitcherLast: "Sale", oppAbbr: "PHI" });
  assert.ok(f.some((x) => x.kind === "whiff" && x.html.includes("slider")));
  assert.ok(f.some((x) => x.kind === "best" && x.html.includes("Hitter 9")));
  assert.ok(f.some((x) => x.kind === "mix"));
  // No hitter data at all: nothing to say about hitters.
  const empty = buildMatchup({ arsenal, batters, rowsById: {}, league });
  assert.deepEqual(findings(empty, { pitcherLast: "Sale", oppAbbr: "PHI" }), []);
});

test("the lineup row pools hitters by PA (by pitches for Whiff%)", () => {
  const model = buildMatchup({
    arsenal, league,
    batters: batters.slice(0, 2),
    rowsById: { 100: [row("FF", 100, 0.3, 20, 10, 400)], 101: [row("FF", 300, 0.2, 30, 30, 100)] },
  });
  const ff = model.lineup.FF;
  assert.ok(Math.abs(ff.est_ba - (0.3 * 100 + 0.2 * 300) / 400) < 1e-12);
  assert.ok(Math.abs(ff.whiff_pct - (10 * 400 + 30 * 100) / 500) < 1e-12);
  assert.equal(ff.pa, 400);
});
