// Tests for odds handling: in-game rows never stored as pregame and implausible
// walks lines quarantined (Worker), and
// the frontend guards: team spellings join, mislabeled walks lines are hidden,
// and a price is only shown while its game is pregame.
// Run with: node --test test/odds.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { groupOddsByProp, implausibleLine, refreshOdds, LINE_CEILING as WORKER_CEILING } from "../src/odds.js";
import { normalizeTeam, abbr, plausibleProp, pregameProp, buildScheduleIndex, LINE_CEILING as FRONTEND_CEILING } from "../public/assets/js/domain.js";

const row = (over) => ({ event_id: "e1", market_type: "player_strikeouts", player_name: "Chris Sale", home_team: "Atlanta Braves", away_team: "Philadelphia Phillies", selection: "Over", selection_type: "over", line: 7.5, event_start_time: "2026-09-29T18:00:00Z", sportsbook: "draftkings", odds_american: -110, odds_decimal: 1.91, is_main_line: true, ...over });

test("live (in-game) rows are dropped; rows without the flag are kept", () => {
  const props = groupOddsByProp([row({}), row({ sportsbook: "fanduel", is_live: true, odds_american: 250 }), row({ selection: "Under", selection_type: "under", is_live: false })]);
  assert.equal(props.length, 2);
  assert.deepEqual(props.find((p) => p.selection === "Over").books.map((b) => b.sportsbook), ["draftkings"]);
});

test("every feed team spelling joins to the MLB name", () => {
  const cases = {
    "BOS Red Sox": "BOS", "LA Dodgers": "LAD", "LA Angels": "LAA", "NY Yankees": "NYY", "NY Mets": "NYM",
    "CHI Cubs": "CHC", "CHI White Sox": "CWS", "ARI Diamondbacks": "AZ", "WAS Nationals": "WSH",
    "ATH Athletics": "ATH", "Oakland Athletics": "ATH", "STL Cardinals": "STL", "TOR Blue Jays": "TOR", "NYY": "NYY",
    "Boston Red Sox": "BOS",
  };
  for (const [feed, want] of Object.entries(cases)) assert.equal(abbr(normalizeTeam(feed)), want, feed);
  assert.equal(normalizeTeam("Unknown Club"), "Unknown Club");
});

test("walks lines above 4.5 are treated as mislabeled; other markets are untouched", () => {
  assert.equal(plausibleProp({ market_type: "player_walks_allowed", line: 7.5 }), false);
  assert.equal(plausibleProp({ market_type: "player_walks_allowed", line: 4.5 }), true);
  assert.equal(plausibleProp({ market_type: "player_strikeouts", line: 7.5 }), true);
});

// The exact rows SharpAPI sent on 2026-09-28 (DraftKings, non-main, 6.5/7.5).
const walks = (line, selection, odds, over = {}) =>
  row({ market_type: "player_walks_allowed", line, selection, selection_type: selection.toLowerCase(), odds_american: odds, is_main_line: false, ...over });
const sep28 = [walks(7.5, "Over", 106), walks(7.5, "Under", -142), walks(6.5, "Over", -124, { player_name: "Cam Schlittler" }), walks(6.5, "Under", -107, { player_name: "Cam Schlittler" })];

test("Worker: walks rows above the ceiling are quarantined, never stored as props", () => {
  const quarantine = [];
  const kept = [walks(1.5, "Over", 153, { is_main_line: true }), walks(2.5, "Over", 400), walks(4.5, "Over", 2500), row({}), row({ line: 7.5, market_type: "player_hits_allowed" })];
  const props = groupOddsByProp([...sep28, ...kept], quarantine);
  assert.equal(quarantine.length, 4);
  assert.deepEqual(quarantine, sep28); // kept whole, exactly as sent
  assert.ok(props.every((p) => !(p.market_type === "player_walks_allowed" && p.line > 4.5)));
  // Real alternates (non-main 2.5), the 4.5 boundary and other markets at 7.5 all survive.
  assert.deepEqual(props.map((p) => `${p.market_type} ${p.line}`).sort(), ["player_hits_allowed 7.5", "player_strikeouts 7.5", "player_walks_allowed 1.5", "player_walks_allowed 2.5", "player_walks_allowed 4.5"]);
});

test("Worker and frontend use the same ceiling", () => {
  assert.deepEqual(WORKER_CEILING, FRONTEND_CEILING);
  for (const r of [...sep28, walks(4.5, "Over", 2500), row({})]) assert.equal(implausibleLine(r), !plausibleProp(r));
});

test("refresh: odds:latest keeps its shape, quarantine recorded once per new set, logged without secrets", async () => {
  const kv = new Map([["pitcher_markets", JSON.stringify({ markets: ["player_strikeouts", "player_walks_allowed"] })]]);
  const writes = [];
  const env = {
    SHARPAPI_KEY: "test-key",
    PROPS_DATA: {
      get: async (k, type) => (kv.has(k) ? (type === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
      put: async (k, v) => { writes.push(k); kv.set(k, v); },
    },
  };
  const realFetch = globalThis.fetch;
  const logs = [];
  const saved = { log: console.log, warn: console.warn };
  console.log = console.warn = (...a) => logs.push(a.join(" "));
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [...sep28, row({})], pagination: { has_more: false } }));
  try {
    await refreshOdds(env);
    await refreshOdds(env); // same bad rows again
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(console, saved);
  }
  const latest = JSON.parse(kv.get("odds:latest"));
  assert.deepEqual(Object.keys(latest), ["props", "updated_at"]);
  assert.equal(latest.props.length, 1);
  const q = JSON.parse(kv.get("odds:quarantine"));
  assert.equal(q.count, 4);
  assert.deepEqual(q.rows, sep28);
  assert.deepEqual(writes, ["odds:latest", "odds:quarantine", "odds:latest"]);
  assert.equal(logs.filter((l) => l.startsWith("Odds quarantined:")).length, 4);
  assert.ok(logs.some((l) => l.includes("4 implausible rows quarantined")));
  assert.ok(logs.every((l) => !l.includes("test-key")));
});

test("a price shows only while its game is pregame", () => {
  const game = (status) => ({ home_team: "Atlanta Braves", away_team: "Philadelphia Phillies", home_probable_pitcher: "Chris Sale", game_time: "2026-09-29T18:00:00Z", status });
  const p = { player_name: "Chris Sale", home_team: "Atlanta Braves", away_team: "Philadelphia Phillies", event_start_time: "2026-09-29T18:00:00Z" };
  const now = Date.parse("2026-09-29T18:30:00Z");
  assert.equal(pregameProp(p, buildScheduleIndex([game("Scheduled")]), now), true); // a delay MLB still calls pregame
  assert.equal(pregameProp(p, buildScheduleIndex([game("Warmup")]), now), true);
  assert.equal(pregameProp(p, buildScheduleIndex([game("In Progress")]), now), false);
  assert.equal(pregameProp(p, buildScheduleIndex([game("Final")]), now), false);
  // No MLB match: first-pitch time decides.
  assert.equal(pregameProp(p, {}, now), false);
  assert.equal(pregameProp(p, {}, Date.parse("2026-09-29T17:00:00Z")), true);
  // MLB lists him in a different game: that status doesn't vouch for this event.
  const other = { ...game("Final"), home_team: "New York Mets" };
  assert.equal(pregameProp(p, buildScheduleIndex([other]), Date.parse("2026-09-29T17:00:00Z")), true);
});
