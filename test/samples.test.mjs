// Tests for Player Detail's sample math: median, hit rate with missing values,
// starts only, and the sample slices.
// Run with: node --test test/samples.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { median, hitRate, startsOf, gamesForSample } from "../public/assets/js/domain.js";

test("median: odd count takes the middle, even count averages the two middle values", () => {
  assert.equal(median([7, 3, 9]), 7);
  assert.equal(median([6, 11, 9, 8, 9, 6, 11, 7, 6, 10]), 8.5);
  assert.equal(median([2, 4, 5, 5]), 4.5);
  assert.equal(median([]), null);
});

test("hit rate leaves missing values out and counts a real zero", () => {
  const games = [{ strikeouts: 0 }, { strikeouts: null }, { strikeouts: 9 }, { strikeouts: 7 }];
  const r = hitRate(games, "strikeouts", 7.5, "Over");
  assert.deepEqual([r.n, r.hits, r.missing, r.pct], [3, 1, 1, 33]);
  assert.equal(r.med, 7);
  const u = hitRate(games, "strikeouts", 7.5, "Under");
  assert.equal(u.hits, 2);
});

test("starts only, sliced from the most recent", () => {
  const log = Array.from({ length: 30 }, (_, i) => ({ date: `2026-04-${String(i + 1).padStart(2, "0")}`, started: i !== 29, opponent: i % 5 ? "A" : "B" }));
  const { games, leftOut } = startsOf(log);
  assert.equal(games.length, 29);
  assert.equal(leftOut.length, 1);
  assert.equal(gamesForSample(games, "L10", null).at(-1).date, "2026-04-29");
  assert.equal(gamesForSample(games, "L25", null).length, 25);
  assert.equal(gamesForSample(games, "H2H", "B").length, 6);
  assert.deepEqual(gamesForSample(games, "H2H", null), []);
});
