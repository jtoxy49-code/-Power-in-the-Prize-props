// How often each sportsbook's NFL prop markets were ACTUALLY refreshed.
//
// Input is the observation log the Worker writes when NFL_ODDS_OBSERVE is
// "true" (KV key nfl:odds:observations): one record per refresh, listing the
// games each sweep covered completely and, per V1 prop, how many markets had a
// two-sided main line and the provider's newest timestamp on them.
//
// The intervals here are measured between successful observations of the same
// book, game and prop. They are not derived from the cron schedule, and a run
// that was skipped, cut short or failed simply does not appear.
//
// Only runs labeled source "live" are measured. Runs produced from a fixture
// or a capture are counted and left out, so structure seen in a fixture is
// never reported as live coverage.
//
//   node scripts/nfl-odds-cadence.mjs --fetch [--save file.json] [--json]
//       reads the hourly log keys from production KV (list and get only; it
//       writes nothing to the account), and optionally saves what it read
//   node scripts/nfl-odds-cadence.mjs file.json [more.json ...] [--json]
//       reports on saved logs instead
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const summarize = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: round(quantile(s, 0.5)), p90: round(quantile(s, 0.9)), max: round(s.at(-1) ?? null) };
};

/**
 * @param {object} log   the stored observation log: { prop_order, runs: [{ at, source, provider_requests_left, sweeps: [{ sportsbook, requests, rows, complete, stopped, games: { game_id: [[n, seen_at], ...] } }] }] }
 * @param {object} [cfg] { freshMinutes, staleMinutes }: the product's freshness thresholds
 */
export function cadenceReport(log, { freshMinutes = 15, staleMinutes = 30 } = {}) {
  const props = log?.prop_order || ["pass_yds", "rush_yds", "rec_yds", "receptions"];
  const all = [...(log?.runs || [])].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const live = all.filter((r) => r.source === "live");
  const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

  const out = {
    runs: { live: live.length, not_live_excluded: all.length - live.length, first: live[0]?.at ?? null, last: live.at(-1)?.at ?? null },
    thresholds: { fresh_minutes: freshMinutes, stale_minutes: staleMinutes },
    run_gap_minutes: summarize(live.slice(1).map((r, i) => minutes(live[i].at, r.at))),
    requests_per_run: summarize(live.map((r) => r.sweeps.reduce((a, s) => a + (s.requests || 0), 0))),
    provider_requests_left_min: live.reduce((a, r) => (r.provider_requests_left == null ? a : a == null ? r.provider_requests_left : Math.min(a, r.provider_requests_left)), null),
    sweeps_cut_short: {},
    books: {},
  };

  // book -> prop -> game -> [{ at, n, seen }]
  const series = {};
  const gamesSeen = {};
  for (const run of live) for (const sweep of run.sweeps || []) {
    if (!sweep.complete) out.sweeps_cut_short[`${sweep.sportsbook}: ${sweep.stopped || "unknown"}`] = (out.sweeps_cut_short[`${sweep.sportsbook}: ${sweep.stopped || "unknown"}`] || 0) + 1;
    for (const [gameId, perProp] of Object.entries(sweep.games || {})) {
      (gamesSeen[sweep.sportsbook] ||= new Set()).add(gameId);
      perProp.forEach(([n, seen], i) => {
        (((series[sweep.sportsbook] ||= {})[props[i]] ||= {})[gameId] ||= []).push({ at: run.at, n, seen });
      });
    }
  }

  for (const [book, byProp] of Object.entries(series)) {
    out.books[book] = { games_checked: gamesSeen[book].size, props: {} };
    for (const prop of props) {
      const byGame = byProp[prop] || {};
      const intervals = [], providerAges = [];
      let pairs = 0, advanced = 0, postedGames = 0, checkedEmpty = 0, observations = 0;
      for (const list of Object.values(byGame)) {
        const posted = list.filter((o) => o.n > 0);
        checkedEmpty += list.length - posted.length;
        observations += posted.length;
        if (posted.length) postedGames++;
        for (const o of posted) if (o.seen) providerAges.push(minutes(o.seen, o.at));
        for (let i = 1; i < posted.length; i++) {
          intervals.push(minutes(posted[i - 1].at, posted[i].at));
          if (posted[i].seen && posted[i - 1].seen) { pairs++; if (posted[i].seen > posted[i - 1].seen) advanced++; }
        }
      }
      // A reader arriving at a random moment sees a price aged uniformly between 0 and the interval it falls in.
      const total = intervals.reduce((a, v) => a + v, 0);
      const within = (limit) => intervals.reduce((a, v) => a + Math.min(v, limit), 0);
      const fresh = total ? within(freshMinutes) / total : null, notStale = total ? within(staleMinutes) / total : null;
      out.books[book].props[prop] = {
        games_with_lines: postedGames, games_checked: Object.keys(byGame).length, observations, checks_with_nothing_posted: checkedEmpty,
        interval_minutes: summarize(intervals),
        share_of_time: total ? { fresh: round(fresh, 3), aging: round(notStale - fresh, 3), stale: round(1 - notStale, 3) } : null,
        provider_timestamp_advanced: pairs ? round(advanced / pairs, 3) : null,
        provider_age_at_fetch_minutes: summarize(providerAges),
      };
    }
  }
  return out;
}

function print(report) {
  const r = report;
  console.log(`Live runs: ${r.runs.live} (${r.runs.first ?? "-"} to ${r.runs.last ?? "-"}); runs not from the live provider, excluded: ${r.runs.not_live_excluded}`);
  if (!r.runs.live) { console.log("No live observations. Nothing here describes the live feed."); return; }
  console.log(`Gap between runs (min): median ${r.run_gap_minutes.median}, p90 ${r.run_gap_minutes.p90}, max ${r.run_gap_minutes.max}`);
  console.log(`Provider requests per run: median ${r.requests_per_run.median}, max ${r.requests_per_run.max}; lowest "requests left this minute" reported: ${r.provider_requests_left_min ?? "not reported"}`);
  console.log(`Sweeps cut short: ${Object.keys(r.sweeps_cut_short).length ? JSON.stringify(r.sweeps_cut_short) : "none"}`);
  for (const [book, b] of Object.entries(r.books)) {
    console.log(`\n${book} (${b.games_checked} games checked)`);
    console.log("  prop        games  obs   interval min (median / p90 / max)   time fresh / aging / stale   provider time advanced   provider age at fetch (median min)");
    for (const [prop, p] of Object.entries(b.props)) {
      const iv = p.interval_minutes, st = p.share_of_time;
      console.log(`  ${prop.padEnd(11)} ${String(p.games_with_lines).padStart(2)}/${String(p.games_checked).padEnd(2)} ${String(p.observations).padStart(4)}   ${iv.n ? `${iv.median} / ${iv.p90} / ${iv.max}`.padEnd(36) : "one observation or none".padEnd(36)} ${st ? `${Math.round(st.fresh * 100)}% / ${Math.round(st.aging * 100)}% / ${Math.round(st.stale * 100)}%`.padEnd(27) : "-".padEnd(27)} ${p.provider_timestamp_advanced == null ? "-".padEnd(23) : `${Math.round(p.provider_timestamp_advanced * 100)}% of refreshes`.padEnd(23)} ${p.provider_age_at_fetch_minutes.median ?? "-"}`);
    }
  }
}

/** Several stored logs (one per hour) as one. */
export function mergeLogs(logs) {
  const runs = new Map();
  for (const log of logs) for (const r of log?.runs || []) runs.set(`${r.at}|${r.source}`, r);
  return { prop_order: logs.find((l) => l?.prop_order)?.prop_order, runs: [...runs.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))) };
}

/** Reads the hourly log keys from production KV. List and get only. */
function fetchLogs() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const wrangler = (args) => execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args, "--binding=PROPS_DATA", "--preview", "false"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const listed = wrangler(["kv", "key", "list", "--prefix", "nfl:odds:observations:"]);
  const keys = JSON.parse(listed.slice(listed.indexOf("["))).map((k) => k.name).sort();
  return keys.map((k) => JSON.parse(wrangler(["kv", "key", "get", k, "--text"])));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const save = args.includes("--save") ? args[args.indexOf("--save") + 1] : null;
  const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--save");
  if (!args.includes("--fetch") && !files.length) { console.error("usage: node scripts/nfl-odds-cadence.mjs --fetch [--save file.json] [--json]\n       node scripts/nfl-odds-cadence.mjs file.json [more.json ...] [--json]"); process.exit(1); }
  const logs = args.includes("--fetch") ? fetchLogs() : files.map((f) => JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")));
  const merged = mergeLogs(logs);
  if (save) writeFileSync(save, JSON.stringify(merged));
  const report = cadenceReport(merged);
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2)); else print(report);
}
