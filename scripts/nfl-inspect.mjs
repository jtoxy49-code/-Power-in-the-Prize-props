// NFL data inspection tool. Read-only and offline: it loads the builder's last
// output (etl/nfl/out/kv.json) into an in-memory KV and calls the real
// /api/nfl/* handler, so what it prints is exactly what the Worker would serve.
// It never calls the odds provider and writes nothing.
//
//   node scripts/nfl-inspect.mjs meta
//   node scripts/nfl-inspect.mjs slate
//   node scripts/nfl-inspect.mjs defense BAL
//   node scripts/nfl-inspect.mjs player "Derrick Henry"
//   node scripts/nfl-inspect.mjs research "Terry McLaurin" rec_yds
//   node scripts/nfl-inspect.mjs odds 2026_04_IND_WAS
//   add --summary for a readable digest instead of the full JSON
//
// ODDS. With --probe-odds the odds come from the rows captured read-only on
// 2026-10-02 (test/fixtures/nfl/odds_probe.json.gz, a local-only file), run through the real
// ingestion code and evaluated five minutes after the capture. They are a
// frozen sample, NOT live prices. Without the flag there are no odds.
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleNflApi } from "../src/nfl/api.js";
import { refreshNflOdds } from "../src/nfl/odds.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [cmd = "meta", a1, a2] = args.filter((a) => !a.startsWith("--"));

const store = new Map(JSON.parse(readFileSync(join(ROOT, "etl", "nfl", "out", "kv.json"), "utf8")).map((e) => [e.key, e.value]));
const kv = { async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { store.set(k, v); } };
const env = { PROPS_DATA: kv };
let now = Date.now();

if (flags.has("--probe-odds")) {
  const capture = join(ROOT, "test", "fixtures", "nfl", "odds_probe.json.gz");
  if (!existsSync(capture)) { console.error("The odds capture is not on this machine (it is the provider's data and is not in the repository)."); process.exit(1); }
  const probe = JSON.parse(gunzipSync(readFileSync(capture)).toString("utf8"));
  const captured = Date.parse(probe.captured_at);
  const fetchImpl = async (url) => {
    const book = url.searchParams.get("sportsbook"), event = url.searchParams.get("event_id"), wanted = url.searchParams.get("market").split(",");
    const list = probe.rows.filter((r) => r.sportsbook === book && wanted.includes(r.market_type) && (!event || r.event_id === event));
    const start = Number(url.searchParams.get("cursor") || 0);
    return { ok: true, status: 200, json: async () => ({ data: list.slice(start, start + 200), pagination: { has_more: start + 200 < list.length, next_cursor: String(start + 200) } }) };
  };
  const quiet = console.log; console.log = () => {};
  await refreshNflOdds({ ...env, SHARPAPI_KEY: "offline-fixture", NFL_ODDS_ENABLED: "true", NFL_ODDS_FANDUEL_GAMES: "16", NFL_ODDS_MAX_REQUESTS: "60" }, { now: captured, fetchImpl });
  console.log = quiet;
  now = captured + 5 * 60000;
  console.error(`[odds are the frozen capture of ${probe.captured_at}, evaluated 5 minutes later; not live]`);
}

const get = async (path) => { const url = new URL(`https://local${path}`); const res = await handleNflApi(new Request(url), env, url, now); return { status: res.status, body: await res.json() }; };
async function playerId(name) {
  if (/^\d{2}-\d{7}$/.test(name || "")) return name;
  const index = await kv.get("nfl:players:index", "json");
  const hits = Object.entries(index.players).filter(([, p]) => p.display_name.toLowerCase() === String(name).toLowerCase());
  if (hits.length !== 1) { console.error(hits.length ? `"${name}" is ambiguous: ${hits.map(([id, p]) => `${id} ${p.team_id} ${p.position}`).join(", ")}` : `no current-roster player named "${name}"`); process.exit(1); }
  return hits[0][0];
}

const pct = (v) => (v == null ? "-" : `${(v * 100).toFixed(1)}%`);
const fmt = (m) => (m.value == null ? "-" : m.unit === "pct" ? pct(m.value) : Number(m.value).toFixed(m.unit === "epa" ? 3 : 2));
function summarize(r) {
  const lines = [];
  const p = r.player, g = r.game, e = r.environment;
  lines.push(`${p.display_name} (${p.position}, ${p.team_id})  ${r.prop.label}  |  ${g ? `${g.is_home === null ? "vs" : g.is_home ? "vs" : "at"} ${g.opponent_id}, ${g.kickoff_utc}, ${g.stadium} (${g.roof})` : "no game this week"}`);
  lines.push(`data through Week ${r.data_through_week} (as of Week ${r.as_of_week}); build ${r.build_id}`);
  if (r.odds) for (const b of r.odds.books) lines.push(`  odds ${b.sportsbook.padEnd(10)} ${b.main ? `line ${b.main.line}  O ${b.main.over} / U ${b.main.under}  hold ${pct(b.main.hold)}` : "no two-sided line"}  ladder ${b.ladder.length} rungs  ${b.status} (${b.age_minutes} min)  provider flagged ${b.provider_flagged_line ?? "-"}`);
  else lines.push("  odds: none stored");
  if (r.odds) lines.push(`  default line ${r.odds.default_line?.line} (${r.odds.default_line?.sportsbook}); books post ${r.odds.best.lines_differ ? "DIFFERENT numbers" : "the same number"}: ${r.odds.best.lines.map((l) => `${l.line} best O ${l.best_over?.price ?? "-"} ${l.best_over?.sportsbook ?? ""} / U ${l.best_under?.price ?? "-"} ${l.best_under?.sportsbook ?? ""}`).join(" | ")}`);
  for (const [k, s] of Object.entries(r.samples)) lines.push(`  ${k.padEnd(6)} games ${s.games}  over ${s.over ?? "-"}  under ${s.under ?? "-"}  push ${s.push ?? "-"}  mean ${s.mean ?? "-"}  median ${s.median ?? "-"}  values [${s.values.join(", ")}]`);
  const u = r.usage?.season;
  if (u) lines.push(`  usage (season, ${u.games} g): ` + (p.position === "QB" ? `att ${u.attempts_pg}/g  dropbacks ${u.dropbacks_pg}/g  pass yds ${u.passing_yards_pg}/g  YPA ${u.ypa}  aDOT ${u.pass_adot}  deep ${pct(u.deep_attempt_rate)}  sack ${pct(u.sack_rate)}  scramble ${pct(u.scramble_rate)}  rush ${u.carries_pg}/g`
    : p.position === "RB" || p.position === "FB" ? `carries ${u.carries_pg}/g  rush yds ${u.rushing_yards_pg}/g  YPC ${u.ypc}  carry share ${pct(u.carry_share)}  backfield share ${pct(u.backfield_carry_share)}  success ${pct(u.rush_success_rate)}  explosive ${pct(u.explosive_run_rate)}  RZ carries ${u.rz_carries}  targets ${u.targets_pg}/g (${pct(u.target_share)})`
    : `targets ${u.targets_pg}/g  target share ${pct(u.target_share)}  rec ${u.receptions_pg}/g  yds ${u.receiving_yards_pg}/g  air share ${pct(u.air_yards_share)}  aDOT ${u.adot}  catch ${pct(u.catch_rate)}  Y/tgt ${u.yards_per_target}  YAC/rec ${u.yac_per_reception}  RZ targets ${u.rz_targets}`));
  lines.push(`  game log: ${r.game_log.map((x) => `wk${x.week} ${x.is_home === 0 ? "@" : ""}${x.opponent_id} ${x.played ? x[r.prop.stat] : `(${x.not_played_reason})`}`).join(" | ")}`);
  if (r.matchup) { lines.push(`  ${r.matchup.opponent_id} defense, ${r.matchup.games} games, entering Week ${r.matchup.as_of_week} (rank 1 = strongest of 32):`); for (const m of r.matchup.metrics) lines.push(`    ${m.tier.padEnd(9)} ${m.label.padEnd(62)} ${fmt(m).padStart(8)}  rank ${String(m.rank ?? "-").padStart(2)}  avg ${fmt({ ...m, value: m.league_avg }).padStart(8)}${m.small_sample ? "  (small sample)" : ""}`); }
  if (e) lines.push(`  environment: team spread ${e.team_spread} (negative = favored), total ${e.total_line}, implied ${e.team_implied_total} vs ${e.opponent_implied_total}; team plays ${e.team_tendencies?.plays_pg}/g, pass rate ${pct(e.team_tendencies?.pass_rate)} (league ${pct(e.team_tendencies?.league_pass_rate)}), neutral ${pct(e.team_tendencies?.neutral_pass_rate)}, PROE ${e.team_tendencies?.pass_rate_over_expected}; weather ${e.weather.status}`);
  const per = r.personnel;
  lines.push(`  personnel: player ${per.player_injury ? `${per.player_injury.game_status ?? "no game status"} / practice ${per.player_injury.practice_status ?? "-"} (${per.player_injury.practice_primary_injury ?? per.player_injury.report_primary_injury ?? "-"})` : "not on the injury report"}; OL listed starters available ${per.offensive_line.available} of 5; opponent defenders out or doubtful: ${per.opponent_defense_out.length ? per.opponent_defense_out.map((d) => `${d.display_name} ${d.position} ${d.game_status}`).join(", ") : "none listed"}`);
  const hurt = per.teammates.filter((t) => t.injury?.game_status || t.injury?.practice_status === "DNP").map((t) => `${t.display_name} ${t.position} ${t.injury.game_status ?? "practice " + t.injury.practice_status}`);
  lines.push(`  teammates on the report: ${hurt.length ? hurt.join(", ") : "none with a game status or DNP"}`);
  lines.push(`  modules: ${Object.entries(r.modules).map(([k, v]) => `${k}=${v}`).join(", ")}; model: ${r.model === null ? "null (reserved, none exists)" : "present"}`);
  return lines.join("\n");
}

let out;
if (cmd === "meta") out = await get("/api/nfl/meta");
else if (cmd === "slate") out = await get("/api/nfl/slate");
else if (cmd === "teams") out = await get("/api/nfl/teams");
else if (cmd === "defense") out = await get(`/api/nfl/defense?team=${a1}`);
else if (cmd === "injuries") out = await get(`/api/nfl/injuries${a1 ? `?team=${a1}` : ""}`);
else if (cmd === "odds") out = await get(`/api/nfl/odds${a1 ? `?game=${a1}` : ""}`);
else if (cmd === "player") out = await get(`/api/nfl/player?id=${await playerId(a1)}`);
else if (cmd === "gamelog") out = await get(`/api/nfl/gamelog?id=${await playerId(a1)}`);
else if (cmd === "research") out = await get(`/api/nfl/research?player=${await playerId(a1)}${a2 ? `&prop=${a2}` : ""}`);
else { console.error(`unknown command "${cmd}"`); process.exit(1); }

if (out.status !== 200) { console.error(`HTTP ${out.status}: ${JSON.stringify(out.body)}`); process.exit(1); }
console.log(flags.has("--summary") && cmd === "research" ? summarize(out.body) : JSON.stringify(out.body, null, 2));
