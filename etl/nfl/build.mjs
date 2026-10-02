// THE NFL BUILDER. Runs outside the Worker (GitHub Actions on a schedule, or
// by hand). It downloads the nflverse files, checks them, derives the weekly
// and as-of tables, and writes three outputs:
//   out/archive/   the source files exactly as consumed, with a manifest   -> R2
//   out/d1.sql     only the table slices whose content changed            -> D1
//   out/kv.json    the current-week serving payloads                      -> KV
// Publishing is a separate, explicit step (see publish.mjs).
//
//   node etl/nfl/build.mjs --season 2026                 download, build, write ./etl/nfl/out
//   node etl/nfl/build.mjs --season 2026 --offline       reuse the download cache
//   node etl/nfl/build.mjs --season 2026 --publish d1    then apply out/d1.sql to remote D1
//   node etl/nfl/build.mjs --season 2026 --publish d1,kv ... and write the payloads to KV
//   node etl/nfl/build.mjs --season 2026 --publish r2,d1,kv  also archive the sources to R2
// Publish order: R2 archive, then D1, then this build's own KV keys, and only
// once those are verified and have settled, the pointer readers follow
// (publish.mjs, src/nfl/snapshot.js). D1 is not on the request path.
// Exit codes: 0 ok; 1 a check failed and nothing was published, or a publish
// step failed and readers were left on the build they had; 2 the data was
// published but the R2 archive failed.
//   --as-of-week N          build as if entering Week N (default: the first week with a game left)
//   --full                  emit every table slice, ignoring what D1 already holds
//   --kv-settle-seconds N   wait before moving the pointer (default 75, never under 60 against the account)
//   --kv-local              publish KV to wrangler's local store instead of the account (rehearsal)
//   --archive-pending       publish without r2: the consumed source files are kept in
//                           etl/nfl/archive-pending/<build id>/ and the build says its archive is pending
// A publish to the account without r2 and without --archive-pending is refused.
//
// The builder never sees the SharpAPI key. Odds are the Worker's job.
import { mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDataset, readDataset, DATASETS } from "./sources.mjs";
import {
  buildGames, currentWeek, ingestedGames, buildRosters, buildPlayers, positionLookup, derivePlayByPlay, defenseGameRows, teamWeekRows, playerWeekRows,
  defenseAsOf, usageAsOf, tendenciesAsOf, injuryRows, depthChartRows, environmentRows,
} from "./derive.mjs";
import { readSchema, planWrites } from "./sql.mjs";
import { buildPayloads } from "./payloads.mjs";
import { NFL_TEAMS } from "../../src/nfl/teams.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** The data checks a build must pass before anything is published. */
// A finished game normally reaches the play-by-play overnight. Past this many
// hours after kickoff a missing game is treated as a fault, not as lag.
export const PBP_LAG_HOURS = 48;

export function runChecks({ games, pbp, defGames, teamWeeks, playerWeeks, rosterInfo, injuryInfo, asOfWeek, builtAt }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
  const finals = games.filter((g) => g.status === "final");
  add("schedule has 32 teams", new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id])).size === 32, `${new Set(games.flatMap((g) => [g.home_team_id, g.away_team_id])).size} teams`);
  const haveDef = new Set(defGames.map((r) => `${r.game_id}|${r.team_id}`));
  const missingGames = finals.filter((g) => !haveDef.has(`${g.game_id}|${g.home_team_id}`) || !haveDef.has(`${g.game_id}|${g.away_team_id}`));
  // A finished game from BEFORE the as-of week must be there: the as-of state is built from it.
  const missingEarlier = missingGames.filter((g) => g.week < asOfWeek);
  add("every finished game before the as-of week is in the play-by-play", missingEarlier.length === 0, missingEarlier.length ? `missing: ${missingEarlier.map((g) => g.game_id).join(", ")}` : `${finals.length - missingGames.length} finished games ingested`);
  // A finished game of the current week may still be waiting for the overnight file. That is lag until it is not.
  const now = Date.parse(builtAt);
  const overdue = missingGames.filter((g) => Number.isFinite(now) && now - Date.parse(g.kickoff_utc) > PBP_LAG_HOURS * 3600_000);
  add(`no finished game has waited more than ${PBP_LAG_HOURS} hours for its play-by-play`, overdue.length === 0, overdue.length ? `overdue: ${overdue.map((g) => g.game_id).join(", ")}` : missingGames.length ? `waiting (normal overnight lag): ${missingGames.map((g) => g.game_id).join(", ")}` : "none waiting");
  add("no unknown team codes", pbp.unmatched.unknown_teams.size === 0 && rosterInfo.unknownTeams.size === 0, JSON.stringify({ pbp: [...pbp.unmatched.unknown_teams], roster: [...rosterInfo.unknownTeams] }));

  // play-by-play against the official box totals
  const box = teamWeeks.reduce((a, r) => ({ att: a.att + (r.box_attempts ?? 0), pbp: a.pbp + r.pass_att, n: a.n + (r.box_attempts == null ? 0 : 1) }), { att: 0, pbp: 0, n: 0 });
  const attDiff = box.att ? Math.abs(box.pbp - box.att) / box.att : 0;
  add("play-by-play pass attempts match box scores within 2%", attDiff <= 0.02, `play-by-play ${box.pbp}, box ${box.att} (${(attDiff * 100).toFixed(2)}% apart; box counts spikes as attempts)`);

  // defense-vs-position classification
  const u = pbp.unmatched;
  const withReceiver = u.targets - u.targets_no_receiver;
  const unknownShare = withReceiver ? u.targets_unknown_position / withReceiver : 0;
  add("receiver position known for at least 99% of targets", unknownShare <= 0.01, `${u.targets_unknown_position} of ${withReceiver} targets to a receiver with no roster position (${(unknownShare * 100).toFixed(2)}%); ${u.targets_other_position} to a non RB/WR/TE; ${u.targets_no_receiver} attempts with no receiver`);

  const teamsWithData = new Set(defGames.filter((r) => r.week < asOfWeek).map((r) => r.team_id)).size;
  add("every defense has a game before the as-of week", asOfWeek <= 1 || teamsWithData === 32 || asOfWeek === 2, `${teamsWithData} of 32 defenses have played before Week ${asOfWeek}`);
  add("player weeks present for finished games", !finals.length || playerWeeks.length > 0, `${playerWeeks.length} player-week rows`);
  add("injury statuses all recognized", injuryInfo.unknown.size === 0, injuryInfo.unknown.size ? `unrecognized: ${JSON.stringify([...injuryInfo.unknown])}` : "all mapped");
  return checks;
}

/**
 * The source archive is part of a publish to the account. Publishing data
 * without it is refused unless the caller says the archive is pending; then
 * the consumed files are kept locally and the build says so.
 */
export function archivePlan(publish, { kvLocal = false, archivePending = false } = {}) {
  const toAccount = publish.includes("d1") || (publish.includes("kv") && !kvLocal);
  const archived = publish.includes("r2");
  return { toAccount, refuse: toAccount && !archived && !archivePending, pending: toAccount && !archived && archivePending };
}

/** Everything a build derives, from already-parsed source rows. Pure. */
export function deriveAll({ season, source, asOfWeek: asOfOverride, capturedDate, buildId, builtAt, snapshots = [] }) {
  const games = buildGames(source.schedule, season);
  const rosterInfo = buildRosters(source.roster_weekly, season);
  const rosters = rosterInfo.rows;
  const players = buildPlayers(rosters);
  const pbp = derivePlayByPlay(source.pbp, positionLookup(rosters));
  // the as-of week waits for the play-by-play, not just for the schedule to say "final"
  const ingested = ingestedGames(pbp);
  const asOfWeek = asOfOverride ?? currentWeek(games, ingested);
  const pendingGames = games.filter((g) => g.status === "final" && !ingested.has(g.game_id)).map((g) => g.game_id);
  const defGames = defenseGameRows(season, pbp);
  const teamWeeks = teamWeekRows(season, pbp, source.stats_team_week);
  const pw = playerWeekRows(season, games, rosters, source.stats_player_week, pbp);

  // as-of state for every week that has a prior week of data, up to the current one
  const asOfWeeks = [];
  for (let w = 2; w <= asOfWeek; w++) asOfWeeks.push(w);
  const defenseByWeek = new Map(asOfWeeks.map((w) => [w, defenseAsOf(season, defGames, w)]));
  const usageByWeek = new Map(asOfWeeks.map((w) => [w, usageAsOf(season, pw.rows, w)]));
  const tendencyByWeek = new Map(asOfWeeks.map((w) => [w, tendenciesAsOf(season, teamWeeks, w)]));

  const injuryInfo = injuryRows(season, source.injuries, capturedDate);
  const depthCharts = depthChartRows(season, source.depth_charts);
  const tendencies = tendencyByWeek.get(asOfWeek) || [];
  const environment = environmentRows(games, tendencies, asOfWeek, capturedDate);
  const rosterWeek = Math.max(0, ...rosters.map((r) => r.week).filter((w) => w <= asOfWeek)) || Math.max(0, ...rosters.map((r) => r.week));

  const checks = runChecks({ games, pbp, defGames, teamWeeks, playerWeeks: pw.rows, rosterInfo, injuryInfo, asOfWeek, builtAt });
  const counts = {
    games: games.length, games_final: games.filter((g) => g.status === "final").length, games_awaiting_play_by_play: pendingGames.length, players: players.length, roster_rows: rosters.length,
    player_weeks: pw.rows.length, player_weeks_stat_only: pw.statOnly, team_weeks: teamWeeks.length, defense_games: defGames.length,
    as_of_weeks: asOfWeeks.length, injuries: injuryInfo.rows.length, depth_chart_rows: depthCharts.length, environment_games: environment.length,
    targets: pbp.unmatched.targets, targets_no_receiver: pbp.unmatched.targets_no_receiver, targets_unknown_position: pbp.unmatched.targets_unknown_position, targets_other_position: pbp.unmatched.targets_other_position,
  };

  const tables = {
    nfl_teams: NFL_TEAMS.map((t) => ({ team_id: t.team_id, abbreviation: t.abbreviation, display_name: t.display_name, city: t.city, nickname: t.nickname, conference: t.conference, division: t.division })),
    nfl_games: games,
    nfl_players: players,
    nfl_rosters: rosters.map((r) => ({ season: r.season, week: r.week, team_id: r.team_id, player_id: r.player_id, position: r.position, depth_chart_position: r.depth_chart_position, jersey_number: r.jersey_number, status: r.status, status_detail: r.status_detail })),
    nfl_player_week: pw.rows,
    nfl_team_week: teamWeeks,
    nfl_defense_game: defGames,
    nfl_defense_week: asOfWeeks.flatMap((w) => defenseByWeek.get(w).rows),
    nfl_defense_position_week: asOfWeeks.flatMap((w) => defenseByWeek.get(w).positionRows),
    nfl_player_usage_week: asOfWeeks.flatMap((w) => usageByWeek.get(w)),
    nfl_team_tendency_week: asOfWeeks.flatMap((w) => tendencyByWeek.get(w)),
    nfl_injuries: injuryInfo.rows,
    nfl_depth_charts: depthCharts,
    nfl_game_environment: environment,
  };

  const derived = {
    season, asOfWeek, buildId, builtAt, capturedDate, games, rosters, rosterWeek, players, playerWeeks: pw.rows, teamWeeks, defGames,
    defenseAsOf: defenseByWeek.get(asOfWeek) || { rows: [], positionRows: [], opponents: new Map() },
    usage: usageByWeek.get(asOfWeek) || [], tendencies, injuries: injuryInfo.rows, depthCharts, environment, snapshots, counts, checks, pbp, pendingGames,
  };
  return { derived, tables, checks, counts, asOfWeek };
}

// ---------- command line ----------
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  const season = Number(opt("--season", new Date().getUTCMonth() >= 7 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1));
  const offline = args.includes("--offline");
  const full = args.includes("--full");
  const outDir = opt("--out", join(HERE, "out"));
  const cacheDir = opt("--cache", join(HERE, ".cache"));
  const asOfArg = opt("--as-of-week", null);
  const publish = (opt("--publish", "") || "").split(",").filter(Boolean);
  const startedAt = new Date().toISOString();
  const buildId = `${season}-${startedAt.replace(/[-:]/g, "").slice(0, 15)}Z`;
  const capturedDate = startedAt.slice(0, 10);

  console.log(`NFL build ${buildId}: season ${season}${offline ? " (offline cache)" : ""}`);
  const source = {}, snapshots = [];
  for (const name of Object.keys(DATASETS)) {
    const snap = await fetchDataset(name, season, { cacheDir, offline });
    const filter = name === "schedule" ? (r) => Number(r.season) === season : undefined;
    source[name] = readDataset(snap, { filter });
    snapshots.push(snap);
    console.log(`  ${name.padEnd(18)} ${String(source[name].length).padStart(7)} rows  ${(snap.size / 1e6).toFixed(2)} MB  source updated ${snap.last_modified || "unknown"}`);
  }
  const archiveKey = (s) => `nflverse/${s.season ? s.season : "all"}/${buildId}/${s.file}`;
  // archive_key is filled in only once the bytes are really in R2
  const snapshotRows = snapshots.map((s) => ({ build_id: buildId, dataset: s.name, season, source: "nflverse", url: s.url, retrieved_at: s.retrieved_at, source_last_modified: s.last_modified, etag: s.etag, sha256: s.sha256, bytes: s.size, rows_total: s.rows_total ?? null, archive_key: null }));

  const { derived, tables, checks, counts, asOfWeek } = deriveAll({ season, source, asOfWeek: asOfArg ? Number(asOfArg) : undefined, capturedDate, buildId, builtAt: startedAt, snapshots: snapshotRows });
  console.log(`  as-of week ${asOfWeek} (data through Week ${asOfWeek - 1}); ${counts.games_final} of ${counts.games} games final`);
  for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  const failed = checks.filter((c) => !c.ok);

  // ---- outputs
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "archive"), { recursive: true });
  for (const s of snapshots) {
    const p = join(outDir, "archive", archiveKey(s));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s.bytes);
  }
  writeFileSync(join(outDir, "archive", "manifest.json"), JSON.stringify({ build_id: buildId, season, as_of_week: asOfWeek, started_at: startedAt, sources: snapshotRows, checks, counts }, null, 2));

  const { readExistingPartitions, publishD1, publishKv, wranglerKv, failureLine, KV_SETTLE_MS, publishR2, readArchivedSnapshots } = await import("./publish.mjs");
  if (failed.length && !args.includes("--allow-failed-checks")) {
    console.log(`BUILD STOPPED: ${failed.length} check(s) failed. Nothing was published; the previous build stays live.`);
    process.exit(1);
  }
  // The source archive belongs to a publish. Leaving it out has to be said, not implied.
  const archiving = archivePlan(publish, { kvLocal: args.includes("--kv-local"), archivePending: args.includes("--archive-pending") });
  if (archiving.refuse) {
    console.log("BUILD STOPPED: a publish includes the source archive. Add r2 to --publish, or pass --archive-pending to publish with the archive explicitly pending. Nothing was published.");
    process.exit(1);
  }
  let archive = { status: "not_published", files: snapshots.length };
  if (archiving.pending) {
    const kept = join(HERE, "archive-pending", buildId);
    cpSync(join(outDir, "archive"), kept, { recursive: true });
    archive = { status: "pending", files: snapshots.length, note: "Source files are held outside the archive bucket until it exists." };
    console.log(`  ARCHIVE PENDING: ${snapshots.length} source files kept in ${kept} (not in R2)`);
  }
  let archiveFailed = 0;
  if (publish.includes("r2")) {
    const files = snapshots.map((s) => ({ dataset: s.name, season, sha256: s.sha256, key: archiveKey(s), path: join(outDir, "archive", archiveKey(s)) }));
    const r2 = publishR2(files, readArchivedSnapshots());
    archiveFailed = r2.failed;
    for (const row of snapshotRows) row.archive_key = r2.keys.get(row.dataset) ?? null;
    archive = { status: r2.failed ? "failed" : "archived", files: snapshots.length };
  }
  derived.archive = archive;
  const schema = readSchema(join(ROOT, "migrations", "0001_nfl_foundation.sql"));
  const existing = full || !publish.includes("d1") ? new Map() : readExistingPartitions();
  const plan = planWrites(schema, tables, existing, { buildId, writtenAt: startedAt });
  const finishedAt = new Date().toISOString();
  const lit = (v) => (v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const tail = [
    ...snapshotRows.map((r) => `INSERT OR REPLACE INTO nfl_data_snapshots (${Object.keys(r).join(",")}) VALUES (${Object.values(r).map(lit).join(",")});`),
    `INSERT OR REPLACE INTO nfl_builds (build_id, season, as_of_week, started_at, finished_at, status, checks_json, counts_json) VALUES (${[buildId, season, asOfWeek, startedAt, finishedAt, failed.length ? "checks_failed" : "ok", JSON.stringify(checks), JSON.stringify(counts)].map(lit).join(",")});`,
  ];
  writeFileSync(join(outDir, "d1.sql"), [...plan.statements, ...tail].join("\n") + "\n");
  const payloads = buildPayloads(derived);
  writeFileSync(join(outDir, "kv.json"), JSON.stringify(Object.entries(payloads).map(([key, value]) => ({ key, value: JSON.stringify(value) }))));
  for (const [key, value] of Object.entries(payloads)) {
    const p = join(outDir, "kv", `${key.replace(/:/g, "__")}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(value, null, 1));
  }
  const kvBytes = Object.values(payloads).reduce((a, v) => a + JSON.stringify(v).length, 0);
  console.log(`  D1: ${plan.written.length} table slices to write (${plan.rows} rows), ${plan.skipped} unchanged and skipped`);
  console.log(`  KV: ${Object.keys(payloads).length} payloads, ${(kvBytes / 1e6).toFixed(2)} MB`);
  console.log(`  output: ${outDir}`);

  if (publish.includes("d1")) publishD1(join(outDir, "d1.sql"));
  if (publish.includes("kv")) {
    const local = args.includes("--kv-local");
    // against the account the wait is never shorter than KV's documented 60 seconds
    const settleMs = local ? Number(opt("--kv-settle-seconds", 0)) * 1000 : Math.max(60, Number(opt("--kv-settle-seconds", KV_SETTLE_MS / 1000))) * 1000;
    try {
      await publishKv(Object.entries(payloads).map(([key, value]) => ({ key, value: JSON.stringify(value) })), { buildId, season, asOfWeek, kv: wranglerKv({ local, dir: outDir }), settleMs });
    } catch (err) {
      console.log(`KV PUBLISH FAILED: ${failureLine(err)}`);
      console.log("The pointer was not moved by this run: readers keep the build they had. D1 may already hold this build's rows; the next run publishes KV again.");
      process.exit(1);
    }
  }
  if (archiveFailed) { console.log(`BUILD DONE WITH A FAILURE: ${archiveFailed} source file(s) could not be archived to R2. The data was published.`); process.exit(2); }
  console.log("BUILD DONE");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error(`BUILD FAILED: ${err.message}`); process.exit(1); });
}
