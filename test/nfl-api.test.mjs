// NFL API and storage: the /api/nfl/* routes over the real builder payloads,
// the research payload, the optional model fields, the D1 schema, and
// idempotent writes (run against a real SQLite engine).
import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { derive, loadOddsRows, memoryKv } from "./fixtures/nfl/load.mjs";
import { buildPayloads } from "../etl/nfl/payloads.mjs";
import { readSchema, planWrites, PARTITIONS } from "../etl/nfl/sql.mjs";
import { handleNflApi } from "../src/nfl/api.js";
import { refreshNflOdds } from "../src/nfl/odds.js";
import { localD1 } from "../etl/nfl/local-d1.mjs";
import { againstLine, PROP_METRICS } from "../src/nfl/research.js";
import { MODEL_FIELDS, PROPS } from "../src/nfl/props.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = join(ROOT, "migrations", "0001_nfl_foundation.sql");
const { derived, tables } = derive();
const payloads = buildPayloads(derived);
const CAPTURE = Date.parse("2026-10-02T03:07:00Z");

async function envWithOdds() {
  const kv = memoryKv(payloads);
  const all = loadOddsRows();
  const fetchImpl = async (url) => {
    const book = url.searchParams.get("sportsbook"), event = url.searchParams.get("event_id"), wanted = url.searchParams.get("market").split(",");
    const list = all.filter((r) => r.sportsbook === book && wanted.includes(r.market_type) && (!event || r.event_id === event));
    const start = Number(url.searchParams.get("cursor") || 0);
    return { ok: true, status: 200, json: async () => ({ data: list.slice(start, start + 200), pagination: { has_more: start + 200 < list.length, next_cursor: String(start + 200) } }) };
  };
  const env = { PROPS_DATA: kv, NFL_DB: await localD1({ only: ["0002_nfl_odds_runs.sql"] }), SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true" };
  await refreshNflOdds(env, { now: CAPTURE, fetchImpl });
  return env;
}
const env = await envWithOdds();
const call = async (path, now = CAPTURE + 5 * 60000) => { const url = new URL(`https://pwr-props.com${path}`); const res = await handleNflApi(new Request(url), env, url, now); return { status: res.status, body: await res.json(), headers: res.headers }; };
const idOf = (name) => derived.players.find((p) => p.display_name === name).player_id;

test("the builder publishes a compact set of current-week payloads", () => {
  const keys = Object.keys(payloads);
  for (const k of ["nfl:meta", "nfl:slate:current", "nfl:slate:2026:4", "nfl:rosters:current", "nfl:status:latest", "nfl:defense:2026:4", "nfl:defense:current", "nfl:players:index", "nfl:team:BAL"]) assert.ok(keys.includes(k), k);
  assert.equal(keys.filter((k) => k.startsWith("nfl:team:")).length, 32);
  assert.ok(keys.length <= 45, "a build is a few dozen KV writes, not one per player");
  for (const [k, v] of Object.entries(payloads)) assert.ok(JSON.stringify(v).length < 1_000_000, `${k} is under 1 MB`);
  assert.equal(payloads["nfl:meta"].data_through_week, 3);
  assert.deepEqual(payloads["nfl:meta"].modules, { snap_counts: false, routes: false, coverage: false, weather: false, model: false });
});

test("GET /api/nfl/slate: this week's games with environment and no invented weather", async () => {
  const { status, body } = await call("/api/nfl/slate");
  assert.equal(status, 200);
  assert.equal(body.week, 4); assert.equal(body.games.length, 16);
  const g = body.games.find((x) => x.game_id === "2026_04_TEN_BAL");
  assert.equal(g.environment.home_implied_total, 27);
  assert.equal(g.environment.weather.status, "not_configured");
  assert.equal(g.environment.weather.temperature_f, null);
  assert.equal(body.games.find((x) => x.roof === "dome").environment.weather.status, "indoors");
});

test("GET /api/nfl/defense: value, rank, percentile and league average, plus defense versus position", async () => {
  const { status, body } = await call("/api/nfl/defense?team=atl");
  assert.equal(status, 200);
  assert.equal(body.team_id, "ATL"); assert.equal(body.as_of_week, 4); assert.equal(body.games, 3);
  assert.equal(body.vs_position.RB.rush_yards_per_game.rank, 1);
  assert.equal(typeof body.metrics.pass_epa_per_dropback.value, "number");
  assert.equal(typeof body.league.pass_epa_per_dropback, "number");
  assert.equal(body.opponents.length, 3);
  assert.equal((await call("/api/nfl/defense?team=LAR")).status, 400, "only canonical team ids are accepted");
});

test("GET /api/nfl/player and /gamelog: profile, usage windows and a log where unplayed weeks are not zeros", async () => {
  const { status, body } = await call(`/api/nfl/player?id=${idOf("Derrick Henry")}`);
  assert.equal(status, 200);
  assert.equal(body.player.position, "RB"); assert.equal(body.player.team_id, "BAL");
  assert.equal(body.player.usage.season.carries_pg, 22);
  assert.equal(body.player.game_log.length, 3);
  const log = await call(`/api/nfl/gamelog?id=${idOf("Derrick Henry")}`);
  assert.deepEqual(log.body.game_log.map((g) => g.rushing_yards), [144, 68, 89]);
  assert.equal((await call("/api/nfl/player?id=Derrick%20Henry")).status, 400, "a name is not an identifier");
  assert.equal((await call("/api/nfl/player?id=00-0000001")).status, 404);
});

test("GET /api/nfl/injuries: normalized statuses and the depth chart", async () => {
  const { body } = await call("/api/nfl/injuries?team=BAL");
  assert.equal(body.team_id, "BAL");
  assert.ok(body.injuries.length > 0 && body.depth_chart.length > 40);
  for (const i of body.injuries) assert.ok([null, "OUT", "DOUBTFUL", "QUESTIONABLE"].includes(i.game_status));
});

test("GET /api/nfl/odds: each book carries its age; only exposed V1 markets are listed by default", async () => {
  const fresh = await call("/api/nfl/odds?game=2026_04_IND_WAS");
  assert.ok(fresh.body.markets.length >= 20);
  assert.ok(fresh.body.markets.every((m) => m.exposed && m.game_id === "2026_04_IND_WAS"));
  for (const m of fresh.body.markets) for (const b of m.books) { assert.equal(b.status, "fresh"); assert.equal(b.age_minutes, 5); }
  const all = await call("/api/nfl/odds?game=2026_04_IND_WAS&exposed=all");
  assert.ok(all.body.markets.length > fresh.body.markets.length, "QB rushing and RB receiving rows are stored, hidden by default");
  // forty minutes later every price is stale and none is offered as best
  const later = await call("/api/nfl/odds?game=2026_04_IND_WAS", CAPTURE + 40 * 60000);
  for (const m of later.body.markets) { assert.ok(m.books.every((b) => b.status === "stale")); assert.ok(m.best.lines.every((l) => l.best_over === null && l.best_under === null)); }
});

test("GET /api/nfl/research: one coherent payload per player and prop", async () => {
  const { status, body } = await call(`/api/nfl/research?player=${idOf("Terry McLaurin")}&prop=rec_yds`);
  assert.equal(status, 200);
  for (const k of ["player", "prop", "game", "environment", "odds", "samples", "usage", "game_log", "matchup", "personnel", "modules", "model"]) assert.ok(k in body, k);
  assert.equal(body.player.position, "WR"); assert.equal(body.prop.prop_type, "rec_yds");
  assert.equal(body.game.game_id, "2026_04_IND_WAS"); assert.equal(body.game.opponent_id, "IND");
  assert.deepEqual(body.odds.books.map((b) => [b.sportsbook, b.main.line]), [["draftkings", 51.5], ["fanduel", 50.5]]);
  assert.deepEqual(body.odds.default_line, { line: 51.5, sportsbook: "draftkings" });
  assert.equal(body.odds.best.lines_differ, true);
  assert.equal(body.samples.season.line, 51.5);
  assert.equal(body.samples.season.games, body.samples.season.over + body.samples.season.under + body.samples.season.push);
  assert.equal(body.matchup.opponent_id, "IND");
  const tiers = PROP_METRICS.rec_yds;
  assert.equal(body.matchup.metrics.length, tiers.primary.length + tiers.secondary.length + tiers.context.length);
  for (const m of body.matchup.metrics) { assert.ok(m.label && m.of === 32); assert.ok(m.value == null || (m.rank >= 1 && m.rank <= 32 && typeof m.league_avg === "number")); }
  assert.ok(body.matchup.metrics.some((m) => m.scope === "vs_WR" && m.metric_key === "yards_per_target"));
  assert.equal(body.matchup.classification, null, "Phase 1 lists metrics; it does not classify the matchup");
  assert.equal(body.personnel.offensive_line.of, 5);
  assert.equal(body.environment.weather.status, "not_configured");
});

test("the research payload works with no odds, and its prop defaults by position", async () => {
  const { body } = await call(`/api/nfl/research?player=${idOf("Derrick Henry")}`);
  assert.equal(body.prop.prop_type, "rush_yds");
  assert.equal(body.environment.team_spread, -11.5, "Baltimore is an 11.5-point favorite");
  assert.equal(body.environment.team_implied_total, 27);
  assert.ok(body.matchup.metrics.some((m) => m.scope === "vs_RB" && m.metric_key === "ypc" && m.rank === 9));
  const bare = { PROPS_DATA: memoryKv(payloads) };
  const url = new URL(`https://pwr-props.com/api/nfl/research?player=${idOf("Derrick Henry")}`);
  const noOdds = await (await handleNflApi(new Request(url), bare, url, CAPTURE)).json();
  assert.equal(noOdds.odds, null);
  assert.equal(noOdds.samples.season.line, null);
  assert.equal(noOdds.samples.season.games, 3);
  assert.equal(noOdds.samples.season.mean, 100.33);
  assert.equal((await call(`/api/nfl/research?player=${idOf("Derrick Henry")}&prop=touchdowns`)).status, 400);
});

test("the model interface is reserved and empty: every payload works with it null", async () => {
  assert.deepEqual(MODEL_FIELDS, ["projected_mean", "projected_median", "lower_interval", "upper_interval", "prob_over", "prob_under", "confidence", "model_version", "generated_at"]);
  for (const name of ["Lamar Jackson", "Derrick Henry", "Chris Olave", "Trey McBride"]) {
    const { status, body } = await call(`/api/nfl/research?player=${idOf(name)}`);
    assert.equal(status, 200, name);
    assert.equal(body.model, null);
    const text = JSON.stringify(body);
    for (const f of MODEL_FIELDS.filter((x) => x.startsWith("proj") || x.startsWith("prob"))) assert.ok(!text.includes(`"${f}"`), `no ${f} field is fabricated`);
    assert.ok(!/snap_share|routes_run|route_participation/.test(text), "no snap or route figure appears");
  }
});

test("results against a line: an unplayed game is left out, a push is neither over nor under", () => {
  const games = [{ played: 1, receptions: 5 }, { played: 1, receptions: 3 }, { played: 0, receptions: null }, { played: 1, receptions: 4 }, { played: 1, receptions: 0 }];
  const r = againstLine(games, "receptions", 4);
  assert.equal(r.games, 4); assert.equal(r.not_counted, 1);
  assert.equal(r.over, 1); assert.equal(r.under, 2); assert.equal(r.push, 1);
  assert.equal(r.over_rate, 0.3333, "one over in three decided games; the push is excluded");
  assert.equal(r.mean, 3, "the real 0 counts; the missing game does not");
  assert.equal(againstLine(games, "receptions", null).over, null);
});

// Production today holds only the unversioned keys (nfl:meta, nfl:slate:current, ...): no nfl:current
// pointer and no nfl:build:* keys. The reader deployed before the first versioned publish must serve
// exactly that, and must not write anything.
test("with no nfl:current pointer, every builder route is served from the unversioned keys, and nothing is written", async () => {
  const kv = memoryKv(payloads);
  assert.ok(![...kv.store.keys()].some((k) => k === "nfl:current" || k.startsWith("nfl:build:")), "the state production is in");
  const reads = [];
  const watched = { get: (k, t) => { reads.push(k); return kv.get(k, t); }, put: () => { throw new Error("a reader never writes"); } };
  const get = async (path) => { const url = new URL(`https://pwr-props.com${path}`); const res = await handleNflApi(new Request(url), { PROPS_DATA: watched }, url, CAPTURE + 5 * 60000); return { status: res.status, body: await res.json(), build: res.headers.get("x-nfl-build") }; };
  const id = idOf("Terry McLaurin");
  for (const path of ["/api/nfl/meta", "/api/nfl/slate", `/api/nfl/player?id=${id}`, `/api/nfl/gamelog?id=${id}`, "/api/nfl/defense?team=BAL", "/api/nfl/injuries", "/api/nfl/injuries?team=WAS", `/api/nfl/research?player=${id}`, `/api/nfl/research?player=${id}&prop=receptions`]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.build, "unversioned", `${path} says which keys it read`);
    if (r.body.build_id) assert.equal(r.body.build_id, payloads["nfl:meta"].build_id, `${path} is the build those keys hold`);
  }
  assert.equal((await get(`/api/nfl/research?player=${id}`)).body.model, null);
  assert.equal((await get("/api/nfl/player?id=Terry%20McLaurin")).status, 400, "a name is not an id");
  assert.equal((await get("/api/nfl/player?id=00-0000000")).status, 404);
  assert.equal((await get("/api/nfl/defense?team=XXX")).status, 400);
  const odds = await get("/api/nfl/odds");
  assert.deepEqual([odds.status, odds.body.markets.length, odds.body.note], [200, 0, "no NFL odds have been stored"], "no odds key: an empty answer, not an error");
  // what was read: the pointer (absent) and then only unversioned keys
  assert.ok(reads.includes("nfl:current"));
  assert.ok(reads.filter((k) => k !== "nfl:current").every((k) => !k.startsWith("nfl:build:")));
  assert.equal(kv.writes.length, 0, "nothing written");
  assert.ok(![...kv.store.keys()].some((k) => k === "nfl:current" || k.startsWith("nfl:build:")), "and no pointer or build key appeared");
});

test("the NFL routes are GET only, unknown routes are 404, and nothing is public by itself", async () => {
  assert.equal((await call("/api/nfl/nope")).status, 404);
  const url = new URL("https://pwr-props.com/api/nfl/slate");
  assert.equal((await handleNflApi(new Request(url, { method: "POST" }), env, url)).status, 405);
  const index = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  const gate = index.indexOf("checkEntitlement(session, env)"), mount = index.indexOf('url.pathname.startsWith("/api/nfl/")');
  assert.ok(gate > 0 && mount > gate, "the NFL mount sits after the session and Premium gates");
  assert.match((await call("/api/nfl/slate")).headers.get("cache-control"), /^private/);
});

// ---------- D1 ----------
test("every derived row matches the migration's columns exactly", () => {
  const schema = readSchema(MIGRATION);
  for (const [table, rows] of Object.entries(tables)) {
    assert.ok(schema[table], `${table} exists in the migration`);
    assert.ok(PARTITIONS[table], `${table} has a partition rule`);
    assert.ok(schema[table].length <= 100, `${table} is within D1's 100-column limit`);
    if (rows.length) assert.deepEqual(Object.keys(rows[0]).filter((k) => !schema[table].includes(k)), [], `${table}: no stray keys`);
    if (rows.length) assert.deepEqual(schema[table].filter((c) => !(c in rows[0])), [], `${table}: no missing columns`);
  }
  for (const t of ["nfl_games", "nfl_players", "nfl_rosters", "nfl_player_week", "nfl_team_week", "nfl_defense_week", "nfl_defense_position_week", "nfl_injuries", "nfl_game_environment", "nfl_data_snapshots"]) assert.ok(schema[t], t);
  // "snapshot_at" is a capture time; a snap-count column would be snaps, snap_share, offense_snaps ...
  assert.ok(!Object.values(schema).flat().some((c) => /(^|_)snaps?(_|$)/i.test(c)), "no snap-count column in the V1 schema");
});

test("writes are idempotent: the SQL runs in SQLite, a second build writes nothing, and a re-run does not duplicate rows", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { t.skip("node:sqlite is not available in this Node"); return; }
  const schema = readSchema(MIGRATION);
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const first = planWrites(schema, tables, new Map(), { buildId: "b1", writtenAt: "2026-10-02T03:35:00Z" });
  db.exec(first.statements.join("\n"));
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const counts = Object.fromEntries(Object.keys(tables).map((tb) => [tb, count(tb)]));
  for (const [tb, rows] of Object.entries(tables)) assert.equal(counts[tb], rows.length, `${tb}: every row landed once`);

  // what D1 now holds, read back the way the builder does
  const existing = new Map(db.prepare("SELECT table_name, part, content_hash FROM nfl_partitions").all().map((r) => [`${r.table_name}|${r.part}`, r.content_hash]));
  const second = planWrites(schema, tables, existing, { buildId: "b2", writtenAt: "2026-10-02T04:00:00Z" });
  assert.equal(second.statements.length, 0, "an unchanged build writes no rows at all");
  assert.equal(second.skipped, first.written.length);

  // forcing a full re-run replaces slices instead of duplicating them
  db.exec(planWrites(schema, tables, new Map(), { buildId: "b3", writtenAt: "2026-10-02T05:00:00Z" }).statements.join("\n"));
  for (const tb of Object.keys(tables)) assert.equal(count(tb), counts[tb], `${tb}: no duplicate rows after a re-run`);

  // a stat correction in one week rewrites only that week's slices
  const corrected = { ...tables, nfl_player_week: tables.nfl_player_week.map((r) => (r.week === 2 && r.played && r.receiving_yards > 50 ? { ...r, receiving_yards: r.receiving_yards + 1 } : r)) };
  const third = planWrites(schema, corrected, existing, { buildId: "b4", writtenAt: "2026-10-02T06:00:00Z" });
  assert.deepEqual(third.written.map((w) => `${w.table}|${w.part}`), ["nfl_player_week|season=2026/week=2"]);

  // time-aware history is queryable: the same team, entering two different weeks
  const rows = db.prepare("SELECT as_of_week, value, rank, games FROM nfl_defense_week WHERE team_id = 'BAL' AND metric_key = 'ypc_allowed' ORDER BY as_of_week").all();
  assert.deepEqual(rows.map((r) => [r.as_of_week, r.games]), [[2, 1], [3, 2], [4, 3]]);
});

test("a new injury capture is added only when the report changes, and then history is kept", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { t.skip("node:sqlite is not available in this Node"); return; }
  const schema = readSchema(MIGRATION);
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(MIGRATION, "utf8"));
  const only = { nfl_injuries: tables.nfl_injuries };
  db.exec(planWrites(schema, only, new Map(), { buildId: "b1", writtenAt: "x" }).statements.join("\n"));
  const existing = () => new Map(db.prepare("SELECT table_name, part, content_hash FROM nfl_partitions").all().map((r) => [`${r.table_name}|${r.part}`, r.content_hash]));
  const nextDay = tables.nfl_injuries.map((r) => ({ ...r, captured_date: "2026-10-03" }));
  assert.equal(planWrites(schema, { nfl_injuries: nextDay }, existing(), { buildId: "b2", writtenAt: "x" }).statements.length, 0, "same report the next day: nothing written");
  const target = nextDay.find((r) => r.week === 4 && r.practice_status === "DNP");
  const changed = nextDay.map((r) => (r === target ? { ...r, practice_status: "LIMITED", practice_status_raw: "Limited Participation in Practice" } : r));
  db.exec(planWrites(schema, { nfl_injuries: changed }, existing(), { buildId: "b3", writtenAt: "x" }).statements.join("\n"));
  const ladder = db.prepare("SELECT captured_date, practice_status FROM nfl_injuries WHERE player_id = ? AND week = 4 ORDER BY captured_date").all(target.player_id);
  assert.deepEqual(ladder.map((r) => [r.captured_date, r.practice_status]), [["2026-10-02", "DNP"], ["2026-10-03", "LIMITED"]], "the day-by-day practice ladder accumulates");
});

test("V1 stays locked to four props", () => {
  assert.equal(Object.keys(PROPS).length, 4);
  assert.deepEqual(Object.keys(PROP_METRICS).sort(), Object.keys(PROPS).sort());
});

// ---------- Phase 1.5: production foundation ----------
test("ladders are not in user-facing routes unless asked for; the count always is", async () => {
  const id = idOf("Terry McLaurin");
  const plain = await call(`/api/nfl/research?player=${id}&prop=rec_yds`);
  for (const b of plain.body.odds.books) { assert.equal("ladder" in b, false, `${b.sportsbook} has no ladder array`); assert.equal(typeof b.ladder_count, "number"); assert.ok(b.fetched_at && b.status && b.age_minutes != null); }
  assert.equal(plain.body.odds.books.find((b) => b.sportsbook === "fanduel").ladder_count, 13);
  assert.equal(plain.body.odds.books.find((b) => b.sportsbook === "draftkings").ladder_count, 0);
  const asked = await call(`/api/nfl/research?player=${id}&prop=rec_yds&ladders=1`);
  assert.equal(asked.body.odds.books.find((b) => b.sportsbook === "fanduel").ladder.length, 13);
  const odds = await call("/api/nfl/odds?game=2026_04_IND_WAS");
  assert.ok(odds.body.markets.every((m) => m.books.every((b) => !("ladder" in b) && typeof b.ladder_count === "number" && b.fetched_at)));
  const withLadders = await call("/api/nfl/odds?game=2026_04_IND_WAS&ladders=1");
  assert.ok(withLadders.body.markets.some((m) => m.books.some((b) => b.ladder?.length > 5)));
});

test("the cron gives MLB first call on the provider: NFL odds start only after the MLB refresh settles", () => {
  const index = readFileSync(join(ROOT, "src", "index.js"), "utf8");
  assert.match(index, /const mlbOdds = refreshOdds\(env\);\s*ctx\.waitUntil\(mlbOdds\);/);
  assert.match(index, /mlbOdds\.catch\(\(\) => \{\}\)\.then\(\(\) => refreshNflOdds\(env\)\)/);
});
