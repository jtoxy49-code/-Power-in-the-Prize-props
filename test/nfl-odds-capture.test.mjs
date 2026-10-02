// LOCAL-ONLY check of the odds pipeline against the real SharpAPI rows captured
// read-only on 2026-10-02. That capture is the provider's data and is not in
// the repository (see .gitignore), so on a machine without it, and in CI, this
// test is skipped. Everything it proves structurally is also covered by
// nfl-odds.test.mjs on the synthetic feed.
import test from "node:test";
import assert from "node:assert/strict";
import { loadCaptureRows, derive } from "./fixtures/nfl/load.mjs";
import { normalizeOddsRows, buildBookMarkets, mergeMarkets, bestPrices } from "../src/nfl/odds-rules.js";
import { buildPayloads } from "../etl/nfl/payloads.mjs";

const rows = loadCaptureRows();

test("the real capture: every V1 row resolves, and FanDuel's main lines come from the rule, not the flag", { skip: rows ? false : "the odds capture is not on this machine" }, () => {
  const p = buildPayloads(derive().derived);
  const now = Date.parse("2026-10-02T03:07:00Z");
  const norm = normalizeOddsRows(rows, { games: p["nfl:slate:current"].games, rosters: p["nfl:rosters:current"].teams, now });
  assert.equal(rows.length, 1200);
  assert.equal(norm.quarantine.length, 0, "121 of 124 names matched in the probe; the rest were kickers outside V1 or resolve through roster first names");
  assert.equal(norm.dropped.duplicate, 0);
  assert.ok(norm.dropped.live > 30, "the game in progress is dropped");
  const markets = mergeMarkets(["draftkings", "fanduel"].flatMap((b) => buildBookMarkets(norm.offers.filter((o) => o.sportsbook === b), "2026-10-02T03:07:00.000Z").entries));
  const fd = markets.flatMap((m) => m.books.filter((b) => b.sportsbook === "fanduel").map((b) => ({ m, b })));
  assert.equal(fd.length, 25);
  assert.ok(fd.every(({ b }) => b.main && Number.isFinite(b.main.over) && Number.isFinite(b.main.under)), "every FanDuel market has a two-sided main line");
  const yardage = fd.filter(({ m }) => m.prop_type !== "receptions");
  assert.equal(yardage.filter(({ b }) => b.provider_flagged_line !== b.main.line).length, 6, "the provider flag pointed elsewhere in 6 of 16 yardage markets");
  const mclaurin = markets.find((m) => m.player_name === "Terry McLaurin" && m.prop_type === "rec_yds");
  assert.deepEqual(mclaurin.books.map((b) => [b.sportsbook, b.main.line, b.provider_flagged_line]), [["draftkings", 51.5, 51.5], ["fanduel", 50.5, 49.5]]);
  assert.equal(bestPrices({ books: mclaurin.books }, now).lines_differ, true);
  assert.equal(norm.offers.find((o) => o.feed_name === "Kenneth Gainwell").player_name, "Kenny Gainwell");
  assert.equal(norm.offers.find((o) => o.feed_name === "Cameron Skattebo").player_name, "Cam Skattebo");
});
