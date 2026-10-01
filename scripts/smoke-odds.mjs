// Live odds smoke test. Read-only: it reads production KV and MLB's public
// schedule, and writes nothing anywhere.
//
//   node scripts/smoke-odds.mjs                  production odds:latest (needs `npx wrangler whoami` to work)
//   node scripts/smoke-odds.mjs --file odds.json a saved snapshot; never counts as a live pass
//
// PROCEDURE (run whenever live MLB pitcher props are posted; books usually post
// the next day's props in the evening, Eastern):
//  1. Run this script. It reads the feed the app serves (KV odds:latest), the
//     quarantine record (KV odds:quarantine) and MLB's schedule for every game
//     date in the feed, then applies the app's own filters (domain.js) exactly
//     as the Board and Home do.
//  2. It prints one real example per market (Strikeouts, Hits Allowed, Walks,
//     Earned Runs, plus any other market present): player, market, line, over
//     price, under price, book, game, start time, MLB status, and the matching
//     raw feed rows.
//  3. Open the Board for that day and confirm each example shows the same line,
//     both prices, book, game and start time.
//  4. The gate passes only when the script says CHECKS PASS (props present,
//     feed fresh, no started game shown, no duplicate main lines, no walks line
//     above the ceiling shown) and step 3 matched for every example.
// Exit code: 0 checks pass, 1 a check failed, 2 nothing to test (no props,
// stale feed, or a snapshot).
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getLineupsForDate } from "../src/lineups.js";
import { slateDate, gameSlateDate } from "../public/assets/js/dates.js";
import {
  normalizeTeam,
  plausibleProp,
  pregameProp,
  isPregameStatus,
  buildScheduleIndex,
  scheduleFor,
  groupRows,
  sideBest,
  marketLabel,
  marketRank,
  bookName,
  LINE_CEILING,
} from "../public/assets/js/domain.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRESH_MINUTES = 20; // the feed refreshes every 10 minutes
const args = process.argv.slice(2);
const file = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

// A missing key reads as null; a failed read says why (wrangler's own message).
function kvGet(key) {
  let out;
  try {
    out = execSync(`npx wrangler kv key get "${key}" --binding=PROPS_DATA`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    const message = String(err.stderr || err.message);
    if (message.includes("404: Not Found")) return null; // the key doesn't exist
    console.log(`Reading ${key} failed: ${message.replace(/\x1b\[[0-9;]*m/g, "").match(/ERROR\]\s*(.+)/)?.[1] || "see the wrangler log"}`);
    return null;
  }
  try {
    return JSON.parse(out);
  } catch {
    return null; // "Value not found" and other non-JSON answers
  }
}

const et = (iso) =>
  iso ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "-";
const price = (n) => (n == null ? "-" : n > 0 ? `+${n}` : String(n));

const failures = [];
const notes = [];
const now = Date.now();

// 1. The feed the app serves.
const feed = file ? JSON.parse(readFileSync(file, "utf8")) : kvGet("odds:latest");
if (!feed) {
  console.log("Could not read odds:latest. Check `npx wrangler whoami` from the project folder.");
  process.exit(2);
}
const raw = feed.props || [];
const ageMin = feed.updated_at ? Math.round((now - Date.parse(feed.updated_at)) / 60000) : null;
console.log(`Source: ${file ? `SNAPSHOT ${file} (not live)` : "production KV odds:latest (read-only)"}`);
console.log(`Feed updated: ${feed.updated_at || "never"}${ageMin != null ? ` (${ageMin} min ago)` : ""}; ${raw.length} props`);

const quarantine = file ? null : kvGet("odds:quarantine");
console.log(
  file
    ? "Quarantine record: not read (snapshot mode)"
    : quarantine
    ? `Quarantine record: ${quarantine.count} rows first seen ${quarantine.first_seen_at}: ${[...new Set(quarantine.rows.map((r) => `${r.sportsbook} ${r.market_type} ${r.line}`))].join(", ")}`
    : "Quarantine record: none in KV (nothing quarantined since the Worker guard was deployed, or not deployed yet)"
);

if (!raw.length) {
  console.log("\nNO LIVE PROPS: the feed holds 0 props, so the smoke test cannot run. The live-odds gate is NOT passed.");
  process.exit(2);
}

// 2. MLB's schedule for every game date in the feed, through the Worker's own
// cleaner (in-memory KV stub; nothing is written).
const memKv = new Map();
const env = { PROPS_DATA: { get: async (k) => memKv.get(k) ?? null, put: async (k, v) => memKv.set(k, v) } };
const dates = [...new Set([slateDate(0), ...raw.map((p) => gameSlateDate(p.event_start_time)).filter(Boolean)])].sort();
const games = (await Promise.all(dates.map((d) => getLineupsForDate(env, d).then((r) => r.games).catch(() => (failures.push(`MLB schedule for ${d} failed to load`), []))))).flat();
const schedule = buildScheduleIndex(games);

// 3. The app's own filters, exactly as loadSlate applies them.
const normalized = raw.map((p) => ({ ...p, home_team: normalizeTeam(p.home_team), away_team: normalizeTeam(p.away_team) }));
const plausible = normalized.filter(plausibleProp);
const shown = plausible.filter((p) => pregameProp(p, schedule, now));
console.log(`Shown by the app now: ${shown.length} of ${raw.length} props (${raw.length - plausible.length} above a line ceiling, ${plausible.length - shown.length} for games no longer pregame)`);

// Check: no started game is shown.
const gameOf = (p) => {
  const s = scheduleFor(schedule, p.player_name);
  return s && s.game.home_team === p.home_team && s.game.away_team === p.away_team ? s.game : null;
};
const startedShown = shown.filter((p) => {
  const g = gameOf(p);
  return g ? !isPregameStatus(g.status) : Date.parse(p.event_start_time) <= now;
});
if (startedShown.length) failures.push(`${startedShown.length} props shown for games that have started`);
const startedInFeed = plausible.length - shown.length;
if (startedInFeed) notes.push(`${startedInFeed} feed props belong to games already under way or over; the app hides them`);
notes.push("is_live is not stored per prop: the Worker drops is_live rows before storing (once deployed); started games are caught by MLB status above");

// Check: one main line per player, market, book and side.
const mains = new Map();
for (const p of raw) {
  for (const b of p.books) {
    if (!b.is_main_line) continue;
    const k = `${p.event_id}|${p.player_name}|${p.market_type}|${b.sportsbook}|${p.selection}`;
    mains.set(k, [...(mains.get(k) || []), p.line]);
  }
}
const dupes = [...mains].filter(([, lines]) => new Set(lines).size > 1);
if (dupes.length) failures.push(`${dupes.length} duplicate main lines: ${dupes.slice(0, 5).map(([k, l]) => `${k} -> ${l.join("/")}`).join("; ")}`);
const sides = new Map();
for (const [k, lines] of mains) {
  const base = k.slice(0, k.lastIndexOf("|"));
  sides.set(base, [...(sides.get(base) || []), ...lines]);
}
const split = [...sides].filter(([, lines]) => new Set(lines).size > 1);
if (split.length) failures.push(`${split.length} props whose Over and Under main lines differ: ${split.slice(0, 5).map(([k, l]) => `${k} -> ${[...new Set(l)].join("/")}`).join("; ")}`);

// Check: no suspicious walks mapping reaches the app.
const walksRaw = raw.filter((p) => p.market_type in LINE_CEILING && Number(p.line) > LINE_CEILING[p.market_type]);
const walksShown = shown.filter((p) => p.market_type in LINE_CEILING && Number(p.line) > LINE_CEILING[p.market_type]);
if (walksShown.length) failures.push(`${walksShown.length} walks props above the ${LINE_CEILING.player_walks_allowed} ceiling are shown`);
if (walksRaw.length) notes.push(`${walksRaw.length} walks rows above the ceiling are still in odds:latest (the deployed Worker predates the quarantine); the app hides them: ${[...new Set(walksRaw.map((p) => `${p.player_name} ${p.line}`))].join(", ")}`);

// 4. One real example per market, as the Board shows it, beside the raw feed rows.
const rows = groupRows(shown.length ? shown : plausible, schedule);
const markets = [...new Set(rows.map((r) => r.market))].sort((a, b) => marketRank(a) - marketRank(b));
for (const want of ["player_strikeouts", "player_hits_allowed", "player_walks_allowed", "player_earned_runs"]) {
  if (!markets.includes(want)) notes.push(`no ${marketLabel(want)} props in the feed right now`);
}
console.log("\nExamples (one per market):");
for (const market of markets) {
  const pick =
    rows.find((r) => r.market === market && r.main && r.over && r.under) || rows.find((r) => r.market === market && r.over && r.under) || rows.find((r) => r.market === market);
  const over = sideBest(pick.over);
  const under = sideBest(pick.under);
  const g = gameOf(pick.over || pick.under);
  const feedStart = (pick.over || pick.under).event_start_time;
  console.log(`\n  ${marketLabel(market)}`);
  console.log(`    PLAYER      ${pick.player}`);
  console.log(`    MARKET      ${market}`);
  console.log(`    LINE        ${pick.line}${pick.main ? " (main)" : " (alternate)"}`);
  console.log(`    OVER PRICE  ${over ? `${price(over.odds)} ${bookName(over.book)}` : "-"}`);
  console.log(`    UNDER PRICE ${under ? `${price(under.odds)} ${bookName(under.book)}` : "-"}`);
  console.log(`    BOOK        ${[...new Set([...(pick.over?.books || []), ...(pick.under?.books || [])].map((b) => bookName(b.sportsbook)))].join(", ")}`);
  console.log(`    GAME        ${pick.away_team} @ ${pick.home_team}${g ? ` (MLB gamePk ${g.game_pk})` : " (no MLB match)"}`);
  console.log(`    START TIME  ${et(pick.game_time)}${feedStart && Math.abs(Date.parse(feedStart) - Date.parse(pick.game_time)) > 15 * 60000 ? ` (feed says ${et(feedStart)})` : ""}`);
  console.log(`    MLB STATUS  ${g ? g.status : "unknown"}${g && !isPregameStatus(g.status) ? "  <- started: not shown in the app" : ""}`);
  const feedRows = raw.filter((p) => p.event_id === pick.event_id && p.player_name === pick.player && p.market_type === market && Number(p.line) === pick.line);
  for (const p of feedRows) console.log(`    FEED        ${p.selection} ${p.line}: ${p.books.map((b) => `${b.sportsbook} ${price(b.odds_american)}${b.is_main_line ? " main" : ""}`).join(", ")}`);
}

console.log("\nNotes:");
for (const n of notes) console.log(`  - ${n}`);
if (failures.length) {
  console.log("\nFAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
if (file) {
  console.log("\nSNAPSHOT ONLY: checks ran on a saved file, which never counts as a live pass.");
  process.exit(2);
}
if (ageMin == null || ageMin > FRESH_MINUTES) {
  console.log(`\nSTALE FEED: last refresh ${ageMin} min ago (limit ${FRESH_MINUTES}); fix the refresh before trusting a pass.`);
  process.exit(2);
}
if (!shown.length) {
  console.log("\nNOTHING SHOWN: every prop in the feed is for a game that has started. Rerun when the next slate is posted.");
  process.exit(2);
}
console.log("\nCHECKS PASS. Now confirm each example on the Board (step 3 of the procedure).");
