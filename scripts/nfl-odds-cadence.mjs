// How often each sportsbook's NFL prop markets were ACTUALLY refreshed, and how
// much of the slate that covered.
//
// Input is the run ledger the Worker keeps in D1 (table nfl_odds_runs): one row
// per time the cron reached the NFL odds refresh while it was switched on.
// An attempt row says how the run ended (success, partial, failed, or never
// finished) and lists the games each sweep retrieved completely with, per V1
// prop, the markets that had a two-sided main line and the provider's newest
// timestamp on them. A skip row says why no request was sent.
//
// Everything here is measured between completed retrievals of the same book
// and game. Nothing is derived from the cron schedule: a run that was skipped,
// cut short, failed or killed shows up as exactly that, and as a longer
// interval for the games it did not reach.
//
// Only rows labeled source "live" are measured. Rows produced from a fixture
// or a capture are counted and left out, so structure seen in a fixture is
// never reported as live coverage.
//
//   node scripts/nfl-odds-cadence.mjs --fetch [--hours 48] [--save file.json] [--json]
//       reads the ledger from the production D1 database (one SELECT; it
//       writes nothing), and optionally saves the rows it read
//   node scripts/nfl-odds-cadence.mjs file.json [--json]
//       reports on saved rows instead
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BOOKS = ["draftkings", "fanduel"];
const PROPS = ["pass_yds", "rush_yds", "rec_yds", "receptions"];
const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null);
const round = (v, d = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const summarize = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: round(quantile(s, 0.5)), p90: round(quantile(s, 0.9)), max: round(s.at(-1) ?? null) };
};
const minutes = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;

/**
 * @param {object[]} rows   nfl_odds_runs rows: { started_at, finished_at, kind, outcome, reason, source, requests, provider_requests_left, detail_json }
 * @param {object} [cfg]    { now: ISO time the report is for (default: the last live row), freshMinutes, staleMinutes }
 */
export function cadenceReport(rows, { now, freshMinutes = 15, staleMinutes = 30 } = {}) {
  const all = [...(rows || [])].map((r) => ({ ...r, detail: typeof r.detail_json === "string" ? JSON.parse(r.detail_json) : r.detail_json ?? r.detail ?? null })).sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const live = all.filter((r) => r.source === "live");
  const attempts = live.filter((r) => r.kind === "attempt");
  const stored = attempts.filter((r) => (r.outcome === "success" || r.outcome === "partial") && r.detail?.stored);
  const to = now ?? live.at(-1)?.finished_at ?? live.at(-1)?.started_at ?? null;
  const from = live[0]?.started_at ?? null;
  const count = (list, key) => list.reduce((a, r) => { const k = key(r); a[k] = (a[k] || 0) + 1; return a; }, {});

  const out = {
    window: { from, to, hours: from && to ? round(minutes(from, to) / 60, 2) : null },
    thresholds: { fresh_minutes: freshMinutes, stale_minutes: staleMinutes },
    rows: { live: live.length, not_live_excluded: all.length - live.length },
    runs: {
      attempted: attempts.length,
      success: attempts.filter((r) => r.outcome === "success").length,
      partial: attempts.filter((r) => r.outcome === "partial").length,
      failed: attempts.filter((r) => r.outcome === "failed").length,
      never_finished: attempts.filter((r) => r.outcome === "started").length,
      skipped: live.filter((r) => r.kind === "skip").length,
      skipped_by_reason: count(live.filter((r) => r.kind === "skip"), (r) => r.reason || "unknown"),
    },
    last_stored_refresh_at: stored.at(-1)?.started_at ?? null,
    minutes_since_last_stored_refresh: stored.length && to ? round(minutes(stored.at(-1).started_at, to)) : null,
    problems: attempts.filter((r) => r.outcome !== "success").map((r) => ({ at: r.started_at, outcome: r.outcome === "started" ? "never_finished" : r.outcome, reason: r.reason ?? null })).slice(-20),
    attempt_gap_minutes: summarize(attempts.slice(1).map((r, i) => minutes(attempts[i].started_at, r.started_at))),
    requests_per_attempt: summarize(attempts.filter((r) => r.requests != null).map((r) => r.requests)),
    provider_requests_left_min: attempts.reduce((a, r) => (r.provider_requests_left == null ? a : a == null ? r.provider_requests_left : Math.min(a, r.provider_requests_left)), null),
    sweeps_cut_short: {},
    books: {},
  };
  if (!attempts.length || !to) return out;

  // The slate: the pregame games of the most recent attempt. They were pregame for the whole window.
  const slate = [...attempts].reverse().find((r) => r.detail?.pregame_games?.length)?.detail.pregame_games ?? [];
  const W0 = Date.parse(from), W1 = Date.parse(to);

  // book -> game -> [{ at, props: [[n, seen] x4] }]: completed retrievals only
  const looks = Object.fromEntries(BOOKS.map((b) => [b, {}]));
  const gamesPerAttempt = Object.fromEntries(BOOKS.map((b) => [b, []]));
  for (const run of attempts) {
    const perBook = Object.fromEntries(BOOKS.map((b) => [b, 0]));
    for (const sweep of run.detail?.sweeps || []) {
      if (!looks[sweep.sportsbook]) continue;
      if (!sweep.complete) out.sweeps_cut_short[`${sweep.sportsbook}: ${sweep.stopped || "unknown"}`] = (out.sweeps_cut_short[`${sweep.sportsbook}: ${sweep.stopped || "unknown"}`] || 0) + 1;
      // a run that did not store its result changed nothing readers see: its retrievals do not count
      if (!run.detail?.stored) continue;
      for (const [gameId, props] of Object.entries(sweep.games || {})) {
        (looks[sweep.sportsbook][gameId] ||= []).push({ at: run.started_at, props });
        perBook[sweep.sportsbook]++;
      }
    }
    for (const b of BOOKS) gamesPerAttempt[b].push(perBook[b]);
  }

  for (const book of BOOKS) {
    const byGame = looks[book];
    // where the slate stands at the report time
    const current = { fresh: 0, aging: 0, stale: 0, never_retrieved: 0 };
    const ages = [];
    // slate-time: every slate game, every minute of the window, by the age of that book's last retrieval of it
    const time = { fresh: 0, aging: 0, stale: 0, never_retrieved: 0 };
    let withLines = 0;
    for (const gameId of slate) {
      const list = (byGame[gameId] || []).filter((o) => Date.parse(o.at) <= W1);
      if (!list.length) { current.never_retrieved++; time.never_retrieved += (W1 - W0) / 60000; continue; }
      const age = (W1 - Date.parse(list.at(-1).at)) / 60000;
      ages.push(age);
      current[age <= freshMinutes ? "fresh" : age <= staleMinutes ? "aging" : "stale"]++;
      if (list.at(-1).props.some(([n]) => n > 0)) withLines++;
      time.never_retrieved += Math.max(0, (Date.parse(list[0].at) - W0) / 60000);
      list.forEach((o, i) => {
        const len = ((i + 1 < list.length ? Date.parse(list[i + 1].at) : W1) - Date.parse(o.at)) / 60000;
        time.fresh += Math.min(len, freshMinutes);
        time.aging += Math.min(Math.max(len - freshMinutes, 0), staleMinutes - freshMinutes);
        time.stale += Math.max(len - staleMinutes, 0);
      });
    }
    const total = time.fresh + time.aging + time.stale + time.never_retrieved;
    const share = (v) => (total ? round(v / total, 3) : null);

    const props = {};
    PROPS.forEach((prop, i) => {
      const intervals = [], providerAges = [];
      let pairs = 0, advanced = 0, games = 0, observations = 0, empty = 0, marketsNow = 0;
      for (const gameId of slate) {
        const list = byGame[gameId] || [];
        const posted = list.filter((o) => o.props[i][0] > 0);
        empty += list.length - posted.length;
        observations += posted.length;
        if (posted.length) games++;
        if (list.length) marketsNow += list.at(-1).props[i][0];
        for (const o of posted) if (o.props[i][1]) providerAges.push(minutes(o.props[i][1], o.at));
        for (let k = 1; k < posted.length; k++) {
          intervals.push(minutes(posted[k - 1].at, posted[k].at));
          const a = posted[k - 1].props[i][1], b = posted[k].props[i][1];
          if (a && b) { pairs++; if (b > a) advanced++; }
        }
      }
      props[prop] = {
        games_with_lines: games, player_markets_now: marketsNow, retrievals_with_lines: observations, retrievals_with_nothing_posted: empty,
        interval_minutes: summarize(intervals),
        provider_timestamp_advanced: pairs ? round(advanced / pairs, 3) : null,
        provider_age_at_fetch_minutes: summarize(providerAges),
      };
    });

    out.books[book] = {
      slate_games: slate.length,
      games_retrieved_per_attempt: summarize(gamesPerAttempt[book]),
      slate_now: { ...current, with_lines: withLines, newest_age_minutes: ages.length ? round(Math.min(...ages)) : null, oldest_age_minutes: ages.length ? round(Math.max(...ages)) : null },
      slate_time_share: { fresh: share(time.fresh), aging: share(time.aging), stale: share(time.stale), never_retrieved: share(time.never_retrieved) },
      props,
    };
  }
  return out;
}

function print(r) {
  console.log(`Live ledger rows: ${r.rows.live}; rows not from the live provider, excluded: ${r.rows.not_live_excluded}`);
  if (!r.rows.live) { console.log("No live rows. Nothing here describes the live feed."); return; }
  console.log(`Window: ${r.window.from} to ${r.window.to} (${r.window.hours} h)`);
  console.log(`Attempts: ${r.runs.attempted} = ${r.runs.success} success, ${r.runs.partial} partial, ${r.runs.failed} failed, ${r.runs.never_finished} never finished. Skips: ${r.runs.skipped} ${JSON.stringify(r.runs.skipped_by_reason)}`);
  console.log(`Last stored refresh: ${r.last_stored_refresh_at ?? "none"}${r.minutes_since_last_stored_refresh == null ? "" : ` (${r.minutes_since_last_stored_refresh} min before the end of the window)`}`);
  console.log(`Gap between attempts (min): median ${r.attempt_gap_minutes.median}, p90 ${r.attempt_gap_minutes.p90}, max ${r.attempt_gap_minutes.max} (n=${r.attempt_gap_minutes.n})`);
  console.log(`Provider requests per attempt: median ${r.requests_per_attempt.median}, max ${r.requests_per_attempt.max}; lowest "requests left this minute" reported: ${r.provider_requests_left_min ?? "not reported"}`);
  console.log(`Sweeps cut short: ${Object.keys(r.sweeps_cut_short).length ? JSON.stringify(r.sweeps_cut_short) : "none"}`);
  for (const p of r.problems) console.log(`  problem ${p.at} ${p.outcome}${p.reason ? `: ${p.reason}` : ""}`);
  const pct = (v) => (v == null ? "-" : `${Math.round(v * 100)}%`);
  for (const [book, b] of Object.entries(r.books)) {
    const g = b.games_retrieved_per_attempt, s = b.slate_now, t = b.slate_time_share;
    console.log(`\n${book}: ${b.slate_games} games on the slate; games retrieved per attempt: median ${g.median}, max ${g.max}`);
    console.log(`  slate now: ${s.fresh} fresh, ${s.aging} aging, ${s.stale} stale, ${s.never_retrieved} never retrieved; ${s.with_lines} with lines; newest ${s.newest_age_minutes ?? "-"} min, oldest ${s.oldest_age_minutes ?? "-"} min`);
    console.log(`  slate-time over the window: ${pct(t.fresh)} fresh, ${pct(t.aging)} aging, ${pct(t.stale)} stale, ${pct(t.never_retrieved)} never retrieved`);
    console.log("  prop        games  markets  retrievals  interval min (n: median / p90 / max)   provider time advanced   provider age at fetch (median min)");
    for (const [prop, p] of Object.entries(b.props)) {
      const iv = p.interval_minutes;
      console.log(`  ${prop.padEnd(11)} ${String(p.games_with_lines).padStart(5)}  ${String(p.player_markets_now).padStart(7)}  ${String(p.retrievals_with_lines).padStart(10)}  ${(iv.n ? `${iv.n}: ${iv.median} / ${iv.p90} / ${iv.max}` : "fewer than two retrievals").padEnd(38)} ${(p.provider_timestamp_advanced == null ? "-" : `${pct(p.provider_timestamp_advanced)} of refreshes`).padEnd(23)} ${p.provider_age_at_fetch_minutes.median ?? "-"}`);
    }
  }
}

/** One SELECT against the production D1 database. Reads only. */
function fetchRows(hours) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  if (!/^[0-9T:.Z-]+$/.test(since)) throw new Error("bad time");
  const sql = `SELECT run_id, started_at, finished_at, kind, outcome, reason, source, requests, provider_requests_left, detail_json FROM nfl_odds_runs WHERE started_at >= '${since}' ORDER BY started_at`;
  const text = execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "d1", "execute", "pwr-props-nfl", "--remote", "--json", "--command", sql], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(text.slice(text.indexOf("[")))[0]?.results || [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const files = args.filter((a, i) => !a.startsWith("--") && !["--save", "--hours"].includes(args[i - 1]));
  if (!args.includes("--fetch") && !files.length) { console.error("usage: node scripts/nfl-odds-cadence.mjs --fetch [--hours 48] [--save file.json] [--json]\n       node scripts/nfl-odds-cadence.mjs file.json [--json]"); process.exit(1); }
  const fetched = args.includes("--fetch");
  const rows = fetched ? fetchRows(Number(value("--hours") || 48)) : files.flatMap((f) => JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")));
  if (value("--save")) writeFileSync(value("--save"), JSON.stringify(rows));
  const report = cadenceReport(rows, fetched ? { now: new Date().toISOString() } : {});
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2)); else print(report);
}
