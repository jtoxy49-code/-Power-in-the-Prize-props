// NFL derived metrics on the real 2026 files (Weeks 1-3 played): played and
// missing-versus-zero, weekly as-of calculations, defensive ranks,
// defense-vs-position, position classification, and proof that a later week
// cannot leak into an earlier ranking.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSource, derive } from "./fixtures/nfl/load.mjs";
import { archivePlan } from "../etl/nfl/build.mjs";
import { buildPayloads as payloadsOf } from "../etl/nfl/payloads.mjs";
import { deriveAll } from "../etl/nfl/build.mjs";
import { defenseAsOf, usageAsOf, tendenciesAsOf, easternToUtc, positionGroup, currentWeek } from "../etl/nfl/derive.mjs";
import { DEFENSE_METRICS, rankMetric } from "../src/nfl/metrics.js";
import { normalizeTeam } from "../src/nfl/teams.js";

const { derived, tables, checks } = derive();
const by = (rows, fn) => { const m = new Map(); for (const r of rows) { const k = fn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

test("the real build passes every data check", () => {
  for (const c of checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  assert.equal(derived.asOfWeek, 4, "Weeks 1-3 are complete, so the product is preparing Week 4");
  assert.equal(currentWeek(derived.games), 4);
});

test("kickoff times convert from Eastern to UTC with daylight saving", () => {
  assert.equal(easternToUtc("2026-10-04", "13:00"), "2026-10-04T17:00:00.000Z"); // EDT
  assert.equal(easternToUtc("2026-12-13", "13:00"), "2026-12-13T18:00:00.000Z"); // EST
  assert.equal(easternToUtc("2026-10-01", "20:15"), "2026-10-02T00:15:00.000Z");
});

test("canonical identifiers: every fact row carries season, week, game, team and opponent ids", () => {
  for (const r of tables.nfl_player_week) {
    assert.match(r.player_id, /^\d{2}-\d{7}$/);
    assert.match(r.game_id, /^2026_\d{2}_[A-Z]+_[A-Z]+$/);
    assert.ok(normalizeTeam(r.team_id) === r.team_id && normalizeTeam(r.opponent_id) === r.opponent_id);
  }
  for (const r of tables.nfl_defense_game) assert.ok(r.game_id.includes(r.team_id) && r.game_id.includes(r.opponent_id));
});

test("missing is not zero: a player who did not play has NULL stats, a player who played with none has real zeros", () => {
  const rows = tables.nfl_player_week;
  const out = rows.filter((r) => r.played === 0);
  const played = rows.filter((r) => r.played === 1);
  assert.ok(out.length > 100 && played.length > 1000);
  for (const r of out) {
    for (const f of ["attempts", "carries", "rushing_yards", "targets", "receptions", "receiving_yards", "passing_yards", "target_share", "carry_share"]) assert.equal(r[f], null, `${r.player_id} wk${r.week} ${f}`);
    assert.ok(r.not_played_reason, "an unplayed week says why");
  }
  for (const r of played) for (const f of ["carries", "targets", "receptions", "receiving_yards", "rushing_yards"]) assert.equal(typeof r[f], "number", `${r.player_id} wk${r.week} ${f}`);
  const zero = played.filter((r) => r.position === "WR" && r.targets === 0);
  assert.ok(zero.length > 0, "there are real zero-target games, and they are 0, not null");
});

test("played without snap counts: inactive is not played, a backup QB with no dropback is not a zero-attempt game", () => {
  const rows = tables.nfl_player_week;
  for (const r of rows.filter((x) => x.roster_status === "INA")) assert.equal(r.played, 0);
  const idle = rows.filter((r) => r.position === "QB" && r.roster_status === "ACT" && r.played === 0);
  assert.ok(idle.length > 20, "backup quarterbacks who dressed and never dropped back");
  for (const r of idle) { assert.equal(r.not_played_reason, "active_did_not_play"); assert.equal(r.attempts, null); }
  for (const r of rows.filter((x) => x.position === "QB" && x.played === 1)) assert.ok(r.dropbacks > 0 || r.attempts + r.carries > 0);
  assert.ok(!Object.keys(rows[0]).some((k) => /snap/i.test(k)), "no snap field exists anywhere in the row");
});

test("usage shares are computed from team totals and never exceed 1", () => {
  for (const r of tables.nfl_player_week.filter((x) => x.played === 1)) {
    for (const f of ["carry_share", "target_share", "backfield_carry_share"]) if (r[f] != null) assert.ok(r[f] >= 0 && r[f] <= 1, `${r.player_id} ${f} ${r[f]}`);
    if (r.team_targets) assert.ok(Math.abs(r.target_share - r.targets / r.team_targets) < 1e-3);
  }
  // one team-game: the target shares of everyone who was targeted sum to 1
  const game = by(tables.nfl_player_week.filter((x) => x.played === 1), (r) => `${r.game_id}|${r.team_id}`);
  let checked = 0;
  for (const list of game.values()) {
    const sum = list.reduce((a, r) => a + (r.target_share ?? 0), 0);
    // each share is stored to 4 decimals, so a dozen of them can sum to 1.0002
    if (list[0].team_targets > 0) { assert.ok(sum <= 1.001, `target shares sum to ${sum}`); checked++; }
  }
  assert.ok(checked >= 96);
});

test("defense-vs-position accounts for every pass attempt, and unmatched targets are measured", () => {
  const u = derived.pbp.unmatched;
  const positioned = tables.nfl_defense_game.reduce((a, r) => a + r.rb_tgt + r.wr_tgt + r.te_tgt, 0);
  assert.equal(positioned + u.targets_other_position + u.targets_unknown_position + u.targets_no_receiver, u.targets, "every attempt is in exactly one bucket");
  assert.equal(u.targets_unknown_position, 0, "every receiver in the 2026 fixture has a roster position");
  assert.ok(u.targets_other_position <= 5, "a handful of targets go to a QB or a lineman");
  assert.equal(derived.counts.targets_no_receiver, u.targets_no_receiver);
});

test("position classification: receivers and rushers are grouped by their roster position that week", () => {
  assert.equal(positionGroup("FB"), "RB");
  assert.equal(positionGroup("WR"), "WR");
  assert.equal(positionGroup("QB"), null);
  // an independent path: sum the opponents' box-score lines by position and compare with play-by-play
  const { source } = loadSource();
  const box = new Map();
  for (const r of source.stats_player_week) {
    const pos = positionGroup(r.position);
    if (!pos) continue;
    const k = `${normalizeTeam(r.opponent_team)}|${Number(r.week)}|${pos}`;
    const b = box.get(k) || { tgt: 0, rec: 0, yds: 0 };
    b.tgt += Number(r.targets) || 0; b.rec += Number(r.receptions) || 0; b.yds += Number(r.receiving_yards) || 0;
    box.set(k, b);
  }
  let cells = 0, exactTargets = 0, yardGap = 0, yardTotal = 0;
  for (const r of tables.nfl_defense_game) for (const pos of ["RB", "WR", "TE"]) {
    const b = box.get(`${r.team_id}|${r.week}|${pos}`) || { tgt: 0, rec: 0, yds: 0 };
    const p = pos.toLowerCase();
    cells++;
    if (b.tgt === r[`${p}_tgt`]) exactTargets++;
    yardGap += Math.abs(b.yds - r[`${p}_rec_yds`]); yardTotal += b.yds;
  }
  assert.equal(cells, 288);
  assert.ok(exactTargets / cells >= 0.97, `targets by position agree with box scores in ${exactTargets} of ${cells} defense-game cells`);
  assert.ok(yardGap / yardTotal < 0.01, `receiving yards by position within 1% of box scores (${yardGap} of ${yardTotal})`);
});

test("defensive metrics store value, league average, rank and percentile for all 32 teams", () => {
  const rows = tables.nfl_defense_week.filter((r) => r.as_of_week === 4);
  const keys = new Set(rows.map((r) => r.metric_key));
  for (const m of DEFENSE_METRICS) assert.ok(keys.has(m.key), m.key);
  for (const [key, list] of by(rows, (r) => r.metric_key)) {
    assert.equal(list.length, 32, key);
    const ranks = list.map((r) => r.rank).sort((a, b) => a - b);
    assert.equal(ranks[0], 1);
    assert.ok(ranks[31] <= 32);
    for (const r of list) { assert.equal(typeof r.value, "number"); assert.equal(typeof r.league_avg, "number"); assert.ok(r.percentile >= 0 && r.percentile <= 100); assert.equal(r.games, 3); }
  }
  for (const want of ["rush_epa_per_play", "rush_success_rate", "ypc_allowed", "rush_yards_per_game", "rush_att_per_game", "explosive_run_rate", "runs_10plus_per_game", "runs_20plus_per_game", "stuff_rate", "rush_first_down_rate", "rush_tds_per_game",
    "pass_epa_per_dropback", "dropback_success_rate", "pass_yards_per_game", "ypa_allowed", "completion_pct_allowed", "pass_td_rate", "int_rate", "explosive_pass_rate", "completions_20plus_per_game", "sack_rate"]) assert.ok(keys.has(want), `required V1 metric ${want}`);
  assert.ok(![...keys].some((k) => /pressure|blitz/.test(k)), "pressure and blitz are not available from approved data and are absent");
});

test("rank convention: 1 is the strongest defense, whichever direction is strong", () => {
  const rows = tables.nfl_defense_week.filter((r) => r.as_of_week === 4);
  const of = (key) => rows.filter((r) => r.metric_key === key).sort((a, b) => a.rank - b.rank);
  const ypc = of("ypc_allowed");
  assert.ok(ypc[0].value <= ypc[31].value, "lower yards per carry is rank 1");
  assert.equal(ypc[0].percentile, 100);
  assert.equal(ypc[31].percentile, 0);
  const stuff = of("stuff_rate");
  assert.ok(stuff[0].value >= stuff[31].value, "a HIGHER stuff rate is rank 1");
  const sacks = of("sack_rate");
  assert.ok(sacks[0].value >= sacks[31].value, "a HIGHER sack rate is rank 1");
});

test("ties share the better rank, and a zero denominator has no rank", () => {
  const sums = new Map([["A", { rush_yds: 100, rush_att: 25 }], ["B", { rush_yds: 80, rush_att: 20 }], ["C", { rush_yds: 150, rush_att: 30 }], ["D", { rush_yds: 0, rush_att: 0 }]]);
  const { teams, league_avg } = rankMetric(DEFENSE_METRICS.find((m) => m.key === "ypc_allowed"), sums);
  assert.equal(teams.get("A").rank, 1);
  assert.equal(teams.get("B").rank, 1, "4.0 and 4.0 tie for first");
  assert.equal(teams.get("C").rank, 3, "the next team is third, not second");
  assert.equal(teams.get("D").rank, null);
  assert.equal(teams.get("D").value, null, "no carries faced is missing, not 0.0 yards per carry");
  assert.equal(league_avg, 4.4, "league average is the league-wide rate: 330 / 75");
  assert.equal(teams.get("A").small_sample, true, "25 carries is under the 30-carry minimum and is flagged");
});

test("real 2026 values: defense versus running backs through Week 3", () => {
  const rows = tables.nfl_defense_position_week.filter((r) => r.as_of_week === 4 && r.position === "RB" && r.metric_key === "rush_yards_per_game");
  const get = (t) => rows.find((r) => r.team_id === t);
  assert.equal(get("ATL").value, 48); assert.equal(get("ATL").rank, 1);
  assert.equal(get("CAR").rank, 32); assert.ok(Math.abs(get("CAR").value - 144.6667) < 0.001);
  assert.ok(Math.abs(get("ATL").league_avg - 91.6146) < 0.001);
  const positions = new Set(tables.nfl_defense_position_week.map((r) => r.position));
  assert.deepEqual([...positions].sort(), ["RB", "TE", "WR"]);
  const wrKeys = new Set(tables.nfl_defense_position_week.filter((r) => r.position === "WR").map((r) => r.metric_key));
  for (const k of ["targets_per_game", "receptions_per_game", "rec_yards_per_game", "yards_per_target", "yards_per_reception", "rec_tds_per_game"]) assert.ok(wrKeys.has(k), k);
  assert.ok(!wrKeys.has("carries_per_game"), "carries are an RB-only metric");
});

test("as-of semantics: as_of_week N uses weeks before N only", () => {
  const a3 = defenseAsOf(2026, tables.nfl_defense_game, 3);
  const a4 = defenseAsOf(2026, tables.nfl_defense_game, 4);
  assert.ok(a3.rows.every((r) => r.games === 2), "entering Week 3 every team has played 2 games");
  assert.ok(a4.rows.every((r) => r.games === 3));
  // recompute entering Week 3 by hand from the per-game facts of Weeks 1 and 2
  const bal = tables.nfl_defense_game.filter((r) => r.team_id === "BAL" && r.week < 3);
  const ypc = bal.reduce((a, r) => a + r.rush_yds, 0) / bal.reduce((a, r) => a + r.rush_att, 0);
  const stored = a3.rows.find((r) => r.team_id === "BAL" && r.metric_key === "ypc_allowed");
  assert.ok(Math.abs(stored.value - ypc) < 1e-5);
  // the stored table agrees with the function for both weeks
  const t3 = tables.nfl_defense_week.filter((r) => r.as_of_week === 3 && r.metric_key === "ypc_allowed").map((r) => `${r.team_id}:${r.value}:${r.rank}`).sort();
  assert.deepEqual(t3, a3.rows.filter((r) => r.metric_key === "ypc_allowed").map((r) => `${r.team_id}:${r.value}:${r.rank}`).sort());
  assert.deepEqual([...new Set(tables.nfl_defense_week.map((r) => r.as_of_week))].sort(), [2, 3, 4]);
});

test("no future leakage: changing or adding later weeks cannot change an earlier week's rankings", () => {
  const facts = tables.nfl_defense_game;
  const before = JSON.stringify(defenseAsOf(2026, facts, 3));
  // wreck every Week 3 game and invent a Week 4 blowout
  const tampered = facts.map((r) => (r.week >= 3 ? { ...r, rush_yds: 9999, pass_yds: 9999, rb_rush_yds: 9999, wr_rec_yds: 9999, rush_att: 1, sacks: 0 } : r));
  tampered.push({ ...facts[0], week: 4, rush_yds: 5000, pass_yds: 5000 });
  assert.equal(JSON.stringify(defenseAsOf(2026, tampered, 3)), before, "defense entering Week 3 is identical");
  assert.notEqual(JSON.stringify(defenseAsOf(2026, tampered, 4)), JSON.stringify(defenseAsOf(2026, facts, 4)), "the change does show up entering Week 4, where it belongs");

  const pw = tables.nfl_player_week, tw = tables.nfl_team_week;
  const usage3 = JSON.stringify(usageAsOf(2026, pw, 3)), tend3 = JSON.stringify(tendenciesAsOf(2026, tw, 3));
  const pwT = pw.map((r) => (r.week >= 3 && r.played ? { ...r, targets: 99, carries: 99, receiving_yards: 999 } : r));
  const twT = tw.map((r) => (r.week >= 3 ? { ...r, plays: 999, dropbacks: 999 } : r));
  assert.equal(JSON.stringify(usageAsOf(2026, pwT, 3)), usage3, "usage entering Week 3 is identical");
  assert.equal(JSON.stringify(tendenciesAsOf(2026, twT, 3)), tend3, "tendencies entering Week 3 are identical");
});

test("no future leakage end to end: building as of Week 3 from the full files equals building from Weeks 1-2 alone", () => {
  const { season, source } = loadSource();
  const opts = { season, capturedDate: "2026-09-22", buildId: "t", builtAt: "2026-09-22T00:00:00.000Z" };
  const full = deriveAll({ ...opts, source, asOfWeek: 3 });
  const early = { ...source, pbp: source.pbp.filter((r) => Number(r.week) < 3), stats_player_week: source.stats_player_week.filter((r) => Number(r.week) < 3), stats_team_week: source.stats_team_week.filter((r) => Number(r.week) < 3) };
  const cut = deriveAll({ ...opts, source: early, asOfWeek: 3 });
  const pickWeek = (rows) => JSON.stringify(rows.filter((r) => r.as_of_week === 3));
  for (const t of ["nfl_defense_week", "nfl_defense_position_week", "nfl_player_usage_week", "nfl_team_tendency_week"]) assert.equal(pickWeek(full.tables[t]), pickWeek(cut.tables[t]), `${t} entering Week 3`);
});

test("usage windows are built from games played only, and never name a snap or a route", () => {
  const usage = tables.nfl_player_usage_week.filter((r) => r.as_of_week === 4);
  const henry = derived.players.find((p) => p.display_name === "Derrick Henry");
  const u = usage.find((r) => r.player_id === henry.player_id && r.sample_window === "season");
  assert.equal(u.games, 3);
  assert.equal(u.carries_pg, 22, "24, 16 and 26 carries");
  assert.ok(Math.abs(u.carry_share - 66 / 97) < 1e-3, "66 of Baltimore's 97 carries in those games");
  assert.ok(u.backfield_carry_share > u.carry_share, "his share of running-back carries is higher than his share of all carries");
  for (const k of Object.keys(u)) assert.ok(!/snap|route/i.test(k), `usage carries no ${k}`);
  const olave = derived.players.find((p) => p.display_name === "Chris Olave");
  const o = usage.find((r) => r.player_id === olave.player_id && r.sample_window === "season");
  assert.equal(o.targets_pg, 12);
  assert.ok(o.target_share > 0.25 && o.air_yards_share > 0.4 && o.adot > 8);
  for (const w of ["season", "L5", "L3"]) assert.ok(usage.some((r) => r.sample_window === w));
});

test("injuries normalize to one vocabulary and carry the capture date; depth charts keep the latest snapshot", () => {
  const inj = tables.nfl_injuries;
  assert.ok(inj.length > 900);
  for (const r of inj) {
    assert.ok([null, "OUT", "DOUBTFUL", "QUESTIONABLE"].includes(r.game_status));
    assert.ok([null, "DNP", "LIMITED", "FULL"].includes(r.practice_status));
    assert.equal(r.captured_date, "2026-10-02");
    assert.equal(r.reported_at, null, "the source has no report time; none is invented");
    assert.match(r.player_id, /^\d{2}-\d{7}$/);
  }
  assert.equal(new Set(tables.nfl_depth_charts.map((r) => `${r.team_id}|${r.snapshot_at}`)).size, 32, "one snapshot per team");
});

test("game environment: implied totals come from the spread and total; weather is null, not invented", () => {
  const env = tables.nfl_game_environment;
  assert.equal(env.length, 16, "the 16 games of the current week only");
  const g = env.find((r) => r.game_id === "2026_04_TEN_BAL");
  assert.equal(g.spread_line, 11.5); assert.equal(g.total_line, 42.5);
  assert.equal(g.home_implied_total, 27); assert.equal(g.away_implied_total, 15.5);
  assert.ok(g.home_plays_pg > 40 && g.home_pass_rate > 0.3 && g.home_pass_rate < 0.8);
  for (const r of env) for (const f of ["weather_temperature_f", "weather_wind_mph", "weather_gust_mph", "weather_precip_probability", "weather_updated_at", "weather_source"]) assert.equal(r[f], null);
  for (const t of tables.nfl_team_tendency_week) assert.ok(Math.abs(t.pass_rate + t.rush_rate - 1) < 1e-3);
});

// ---------- Phase 1.5: the builder fails loudly and never publishes a broken dataset ----------
test("schema drift: a source file missing a required column stops the build, naming the dataset", async () => {
  const { readDataset } = await import("../etl/nfl/sources.mjs");
  const csv = Buffer.from("game_id,week,posteam,defteam,play_type,qb_dropback,yards_gained,epa,success,rusher_player_id,passer_player_id\n2026_01_A_B,1,A,B,run,0,3,0.1,1,x,y\n");
  assert.throws(() => readDataset({ name: "pbp", season: 2026, gzip: false, bytes: csv }), /pbp 2026: missing required column\(s\): receiver_player_id/);
  const { DATASETS } = await import("../etl/nfl/sources.mjs");
  for (const [name, ds] of Object.entries(DATASETS)) assert.ok(ds.required.length >= 5, `${name} declares its required columns`);
  assert.ok(!Object.keys(DATASETS).some((n) => /snap|pfr|ftn|ngs/i.test(n)), "no snap-count or unapproved source is in the builder");
});

test("a broken dataset fails its checks, and a failed check is what stops publishing", async () => {
  const { runChecks } = await import("../etl/nfl/build.mjs");
  const { season, source } = loadSource();
  // a play-by-play file that lost a whole game
  const broken = deriveAll({ season, source: { ...source, pbp: source.pbp.filter((r) => r.game_id !== "2026_01_BAL_IND") }, capturedDate: "2026-10-02", buildId: "t", builtAt: "2026-10-02T00:00:00.000Z" });
  const bad = broken.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(bad.some((n) => n.includes("waited more than 48 hours")), "a Week 1 game still missing weeks later is a fault, not lag");
  assert.equal(broken.asOfWeek, 1, "and the as-of week does not move past the week with the hole");
  assert.match(broken.checks.find((c) => !c.ok).detail, /2026_01_BAL_IND/);
  // rosters gone: receivers cannot be classified
  const noRoster = deriveAll({ season, source: { ...source, roster_weekly: source.roster_weekly.filter((r) => r.position !== "WR") }, capturedDate: "2026-10-02", buildId: "t", builtAt: "2026-10-02T00:00:00.000Z" });
  assert.ok(noRoster.checks.some((c) => !c.ok && c.name === "receiver position known for at least 99% of targets"), "unmatched receivers are measured and fail the build");
  assert.equal(typeof runChecks, "function");
  const build = readFileSync(new URL("../etl/nfl/build.mjs", import.meta.url), "utf8");
  assert.ok(build.indexOf("BUILD STOPPED") < build.indexOf("publishD1(join(outDir"), "the check gate comes before any publish call");
  assert.ok(build.indexOf("BUILD STOPPED") < build.indexOf("publishR2(files"), "and before the archive");
});

test("a publish to the account includes the source archive, or says in so many words that the archive is pending", () => {
  assert.deepEqual(archivePlan(["r2", "d1", "kv"]), { toAccount: true, refuse: false, pending: false });
  assert.deepEqual(archivePlan(["d1", "kv"]), { toAccount: true, refuse: true, pending: false }, "leaving r2 out is refused");
  assert.deepEqual(archivePlan(["kv"]), { toAccount: true, refuse: true, pending: false });
  assert.deepEqual(archivePlan(["d1"]), { toAccount: true, refuse: true, pending: false });
  assert.deepEqual(archivePlan(["d1", "kv"], { archivePending: true }), { toAccount: true, refuse: false, pending: true }, "unless it is declared pending");
  assert.deepEqual(archivePlan(["kv"], { kvLocal: true }), { toAccount: false, refuse: false, pending: false }, "a local rehearsal publishes nothing to the account");
  assert.deepEqual(archivePlan([]), { toAccount: false, refuse: false, pending: false });
  // the build stamp says which it was
  assert.deepEqual(payloadsOf(derived)["nfl:meta"].archive, { status: "not_published" });
  assert.deepEqual(payloadsOf({ ...derived, archive: { status: "pending", files: 7 } })["nfl:meta"].archive, { status: "pending", files: 7 });
  const workflow = readFileSync(new URL("../.github/workflows/nfl-builder.yml", import.meta.url), "utf8");
  assert.ok(!/^s*push:/m.test(workflow), "the workflow has no push trigger");
  assert.match(workflow, /vars.NFL_SCHEDULED_PUBLISH == 'true' && 'r2,d1,kv' || 'none'/, "a scheduled run publishes nothing until the repository variable is set, and then always with the archive");
  assert.match(workflow, /default: "none"/, "a manual run publishes nothing unless told what to publish");
});

// How those payloads reach KV, and what a failed publish leaves readers with, is in nfl-publish.test.mjs.
test("every payload the builder produces is in the nfl: namespace, and none uses a name reserved for the publisher or the odds refresh", async () => {
  const { buildPayloads } = await import("../etl/nfl/payloads.mjs");
  const keys = Object.keys(buildPayloads(derived));
  for (const key of keys) assert.ok(key.startsWith("nfl:"), key);
  assert.ok(!keys.some((k) => k === "nfl:current" || k.startsWith("nfl:build:") || k.startsWith("nfl:odds:")));
  assert.ok(keys.includes("nfl:meta"));
});

test("a game the schedule calls final but whose stats have not arrived produces no rows and does not advance the week", () => {
  const { season, source } = loadSource();
  const opts = { season, capturedDate: "2026-10-02", buildId: "t" };
  // Thursday of Week 4 is final in the schedule; the overnight play-by-play does not have it yet
  const schedule = source.schedule.map((g) => (g.game_id === "2026_04_PIT_CLE" ? { ...g, away_score: "20", home_score: "17" } : g));
  const friday = deriveAll({ ...opts, source: { ...source, schedule }, builtAt: "2026-10-02T04:30:00.000Z" });
  assert.equal(friday.asOfWeek, 4, "the week stays open");
  assert.ok(friday.checks.every((c) => c.ok), "ordinary overnight lag is not a failure");
  assert.match(friday.checks.find((c) => c.name.includes("waited more than")).detail, /waiting \(normal overnight lag\): 2026_04_PIT_CLE/);
  assert.deepEqual(friday.derived.pendingGames, ["2026_04_PIT_CLE"]);
  assert.equal(friday.tables.nfl_player_week.filter((r) => r.week === 4).length, 0, "no invented zero-stat games for Pittsburgh or Cleveland");
  assert.equal(JSON.stringify(friday.tables.nfl_defense_week), JSON.stringify(tables.nfl_defense_week), "as-of state is untouched");
  // the same gap three days later is a fault and stops the build
  const monday = deriveAll({ ...opts, source: { ...source, schedule }, builtAt: "2026-10-05T12:00:00.000Z" });
  assert.ok(monday.checks.some((c) => !c.ok && /overdue: 2026_04_PIT_CLE/.test(c.detail)));
  // every game of a week final in the schedule, none ingested: the as-of week still does not move
  const allFinal = source.schedule.map((g) => (Number(g.week) === 4 ? { ...g, away_score: "20", home_score: "17" } : g));
  assert.equal(deriveAll({ ...opts, source: { ...source, schedule: allFinal }, builtAt: "2026-10-05T03:00:00.000Z" }).asOfWeek, 4);
});
