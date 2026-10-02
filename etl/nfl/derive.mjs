// DERIVED METRICS: everything the builder computes from the nflverse files.
// Pure functions: rows in, rows out. No network, no clock, no storage.
//
// TIME-AWARENESS. Per-game facts are keyed by the week they happened in. Every
// aggregate is computed for an `as_of_week` and uses only games with
// week < as_of_week. "as_of_week = 8" is the state entering Week 8: Weeks 1-7.
// Nothing here ever reads a later week to describe an earlier one.
//
// NO SNAP COUNTS. "Played" is decided from the weekly roster and the
// play-by-play, never from snaps, and no snap share is produced or inferred.
import { num, str, flag } from "./csv.mjs";
import { normalizeTeam } from "../../src/nfl/teams.js";
import { DEFENSE_METRICS, POSITION_METRICS, DVP_POSITIONS, rankMetric } from "../../src/nfl/metrics.js";

export const SKILL_POSITIONS = ["QB", "RB", "FB", "WR", "TE"];
// Defense-vs-position groups: a fullback is counted with the running backs.
export const positionGroup = (pos) => (pos === "FB" ? "RB" : DVP_POSITIONS.includes(pos) ? pos : null);

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const div = (a, b) => (b > 0 ? a / b : null);
const bump = (map, key, init) => { let v = map.get(key); if (!v) { v = init(); map.set(key, v); } return v; };

// ---------- schedule ----------

/** A kickoff given as an Eastern date and time, as a UTC ISO string (DST-aware). */
export function easternToUtc(date, time) {
  if (!date || !time) return null;
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  for (const offset of [4, 5]) {
    const utc = new Date(Date.UTC(y, m - 1, d, hh + offset, mm));
    const parts = Object.fromEntries(fmt.formatToParts(utc).map((p) => [p.type, p.value]));
    if (Number(parts.day) === d && Number(parts.hour) % 24 === hh && Number(parts.minute) === mm) return utc.toISOString();
  }
  return null;
}

export function buildGames(scheduleRows, season) {
  const games = [];
  for (const r of scheduleRows) {
    if (Number(r.season) !== season) continue;
    const home = normalizeTeam(r.home_team), away = normalizeTeam(r.away_team);
    if (!home || !away) throw new Error(`schedule ${r.game_id}: unknown team "${r.home_team}" or "${r.away_team}"`);
    const homeScore = num(r.home_score), awayScore = num(r.away_score);
    const spread = num(r.spread_line), total = num(r.total_line);
    games.push({
      game_id: r.game_id, season, season_type: r.game_type === "REG" ? "REG" : "POST", game_type: r.game_type, week: Number(r.week),
      kickoff_utc: easternToUtc(r.gameday, r.gametime), gameday: r.gameday, weekday: str(r.weekday),
      home_team_id: home, away_team_id: away,
      location: r.location === "Neutral" ? "neutral" : "home",
      roof: str(r.roof), surface: str(r.surface), stadium_id: str(r.stadium_id), stadium: str(r.stadium),
      home_rest: num(r.home_rest), away_rest: num(r.away_rest),
      home_score: homeScore, away_score: awayScore, status: homeScore != null && awayScore != null ? "final" : "scheduled",
      // nflverse convention: spread_line is positive when the HOME team is favored.
      spread_line: spread, total_line: total,
      home_implied_total: spread != null && total != null ? round(total / 2 + spread / 2, 2) : null,
      away_implied_total: spread != null && total != null ? round(total / 2 - spread / 2, 2) : null,
      home_moneyline: num(r.home_moneyline), away_moneyline: num(r.away_moneyline),
      home_qb_id: str(r.home_qb_id), away_qb_id: str(r.away_qb_id), home_qb_name: str(r.home_qb_name), away_qb_name: str(r.away_qb_name),
      espn_id: str(r.espn), pfr_id: str(r.pfr), gsis_id: str(r.gsis), old_game_id: str(r.old_game_id), ftn_id: str(r.ftn),
      temp: num(r.temp), wind: num(r.wind),
    });
  }
  games.sort((a, b) => a.week - b.week || (a.kickoff_utc || "").localeCompare(b.kickoff_utc || "") || a.game_id.localeCompare(b.game_id));
  return games;
}

/**
 * The week the product is preparing for: the first week that still has a game
 * to play. Aggregates for it use every earlier week. After the last game of
 * the season it is last week + 1.
 */
export function currentWeek(games) {
  const open = games.filter((g) => g.status !== "final").map((g) => g.week);
  if (open.length) return Math.min(...open);
  return games.length ? Math.max(...games.map((g) => g.week)) + 1 : 1;
}

// ---------- rosters ----------

export function buildRosters(rosterRows, season) {
  const rows = [];
  const unknownTeams = new Map();
  for (const r of rosterRows) {
    if (Number(r.season) !== season || !r.gsis_id) continue;
    const team = normalizeTeam(r.team);
    if (!team) { unknownTeams.set(r.team, (unknownTeams.get(r.team) || 0) + 1); continue; }
    rows.push({
      season, week: Number(r.week), team_id: team, player_id: r.gsis_id, position: str(r.position), depth_chart_position: str(r.depth_chart_position),
      jersey_number: num(r.jersey_number), status: str(r.status), status_detail: str(r.status_description_abbr),
      display_name: str(r.full_name), first_name: str(r.first_name), last_name: str(r.last_name), football_name: str(r.football_name),
      birth_date: str(r.birth_date), years_exp: num(r.years_exp), headshot_url: str(r.headshot_url),
      espn_id: str(r.espn_id), pfr_id: str(r.pfr_id), sleeper_id: str(r.sleeper_id), sportradar_id: str(r.sportradar_id), pff_id: str(r.pff_id),
    });
  }
  return { rows, unknownTeams };
}

/** One row per player: his most recent roster row of the season. */
export function buildPlayers(rosterRows) {
  const latest = new Map();
  for (const r of rosterRows) { const p = latest.get(r.player_id); if (!p || r.week >= p.week) latest.set(r.player_id, r); }
  return [...latest.values()].map((r) => ({
    player_id: r.player_id, display_name: r.display_name, first_name: r.first_name, last_name: r.last_name, football_name: r.football_name,
    position: r.position, position_group: positionGroup(r.position) || r.position, birth_date: r.birth_date, headshot_url: r.headshot_url,
    latest_team_id: r.team_id, latest_status: r.status, latest_season: r.season, latest_week: r.week,
    espn_id: r.espn_id, pfr_id: r.pfr_id, sleeper_id: r.sleeper_id, sportradar_id: r.sportradar_id, pff_id: r.pff_id,
  }));
}

/** position of a player in a given week (that week's roster row; else his nearest week). */
export function positionLookup(rosterRows) {
  const byPlayer = new Map();
  for (const r of rosterRows) bump(byPlayer, r.player_id, () => []).push(r);
  for (const list of byPlayer.values()) list.sort((a, b) => a.week - b.week);
  return (playerId, week) => {
    const list = byPlayer.get(playerId);
    if (!list) return null;
    let best = list[0];
    for (const r of list) { if (r.week === week) return r.position; if (Math.abs(r.week - week) < Math.abs(best.week - week)) best = r; }
    return best.position;
  };
}

// ---------- play-by-play ----------

const newDefense = () => ({
  dropbacks: 0, db_epa: 0, db_success: 0, pass_att: 0, completions: 0, pass_yds: 0, pass_td: 0, ints: 0, sacks: 0, sack_yds: 0, qb_hits: 0,
  pass_20: 0, air_yds: 0, air_att: 0, yac: 0, short_att: 0, short_cmp: 0, scrambles: 0, scramble_yds: 0,
  rush_att: 0, rush_yds: 0, rush_epa: 0, rush_success: 0, rush_10: 0, rush_20: 0, rush_stuffed: 0, rush_fd: 0, rush_td: 0, rz_rush_att: 0,
});
const newOffense = () => ({
  plays: 0, dropbacks: 0, pass_att: 0, sacks: 0, qb_hits: 0, scrambles: 0, rush_att: 0, rush_yds: 0, rush_stuffed: 0,
  rb_carries: 0, rb_rush_yds: 0, neutral_plays: 0, neutral_dropbacks: 0, pass_oe_sum: 0, pass_oe_n: 0, team_targets: 0, team_air_yds: 0,
});
const newPosition = () => ({ tgt: 0, rec: 0, rec_yds: 0, rec_td: 0, air_yds: 0, car: 0, rush_yds: 0, rush_td: 0 });
const newPlayer = () => ({
  dropbacks: 0, pass_att: 0, deep_att: 0, scrambles: 0, scramble_yds: 0, designed_runs: 0, rush_success: 0, rush_10: 0, rush_20: 0,
  rz_carries: 0, gl_carries: 0, targets: 0, rz_targets: 0, rec_20: 0, short_targets: 0,
});

/**
 * One pass over a season's play-by-play.
 * Play definitions (nflfastR columns):
 *   dropback      qb_dropback = 1 on a pass or run play (attempts, sacks, scrambles)
 *   pass attempt  play_type "pass", not a sack
 *   designed run  play_type "run", not a scramble (kneels are a separate play type)
 * Two-point tries are excluded. Spikes, kneels and plays wiped out by penalty
 * have other play types and are excluded with them.
 * @param {(playerId:string, week:number)=>string|null} positionOf
 */
export function derivePlayByPlay(pbpRows, positionOf) {
  const defense = new Map();   // game|team -> facts
  const offense = new Map();   // game|team -> facts
  const position = new Map();  // game|defteam|POS -> facts
  const players = new Map();   // game|player -> extras
  const gameTeams = new Map(); // game|team -> { game_id, week, team_id, opponent_id }
  const unmatched = { targets: 0, targets_no_receiver: 0, targets_unknown_position: 0, targets_other_position: 0, rb_carries_unknown_position: 0, unknown_teams: new Map(), unknown_receivers: new Map() };

  for (const r of pbpRows) {
    const pt = r.play_type;
    if (pt !== "pass" && pt !== "run") continue;
    if (flag(r.two_point_attempt)) continue;
    const off = normalizeTeam(r.posteam), def = normalizeTeam(r.defteam);
    if (!off || !def) { const bad = !off ? r.posteam : r.defteam; unmatched.unknown_teams.set(bad, (unmatched.unknown_teams.get(bad) || 0) + 1); continue; }
    const week = Number(r.week), game = r.game_id;
    const dk = `${game}|${def}`, ok = `${game}|${off}`;
    const D = bump(defense, dk, newDefense), O = bump(offense, ok, newOffense);
    gameTeams.set(dk, { game_id: game, week, team_id: def, opponent_id: off });
    gameTeams.set(ok, { game_id: game, week, team_id: off, opponent_id: def });

    const yards = num(r.yards_gained) ?? 0, epa = num(r.epa), success = num(r.success) ?? 0;
    const yardline = num(r.yardline_100), air = num(r.air_yards);
    const isSack = flag(r.sack), isScramble = flag(r.qb_scramble), isDropback = flag(r.qb_dropback);
    const down = num(r.down), wp = num(r.wp), halfSecs = num(r.half_seconds_remaining);
    const neutral = down != null && down <= 3 && wp != null && wp >= 0.2 && wp <= 0.8 && halfSecs != null && halfSecs > 120;

    O.plays++;
    if (neutral) O.neutral_plays++;
    const poe = num(r.pass_oe);
    if (poe != null) { O.pass_oe_sum += poe; O.pass_oe_n++; }

    if (isDropback) {
      D.dropbacks++; O.dropbacks++;
      if (epa != null) D.db_epa += epa;
      D.db_success += success;
      if (neutral) O.neutral_dropbacks++;
      if (flag(r.qb_hit)) { D.qb_hits++; O.qb_hits++; }
      const qb = isScramble ? str(r.rusher_player_id) : str(r.passer_player_id);
      if (qb) bump(players, `${game}|${qb}`, newPlayer).dropbacks++;
    }

    if (pt === "pass" && isSack) {
      D.sacks++; O.sacks++; D.sack_yds += -yards;
    } else if (pt === "pass") {
      // a pass attempt
      D.pass_att++; O.pass_att++;
      const complete = flag(r.complete_pass);
      const passer = str(r.passer_player_id);
      if (passer) { const P = bump(players, `${game}|${passer}`, newPlayer); P.pass_att++; if (air != null && air >= 20) P.deep_att++; }
      if (air != null) { D.air_yds += air; D.air_att++; O.team_air_yds += air; if (air < 10) { D.short_att++; if (complete) D.short_cmp++; } }
      if (flag(r.interception)) D.ints++;
      if (complete) {
        D.completions++; D.pass_yds += yards; D.yac += num(r.yards_after_catch) ?? 0;
        if (yards >= 20) D.pass_20++;
        if (flag(r.pass_touchdown)) D.pass_td++;
      }
      // the target, by the receiver's position that week
      const receiver = str(r.receiver_player_id);
      unmatched.targets++;
      if (!receiver) unmatched.targets_no_receiver++;
      else {
        O.team_targets++;
        const R = bump(players, `${game}|${receiver}`, newPlayer);
        R.targets++;
        if (yardline != null && yardline <= 20) R.rz_targets++;
        if (air != null && air < 10) R.short_targets++;
        if (complete && yards >= 20) R.rec_20++;
        const raw = positionOf(receiver, week);
        const pos = positionGroup(raw);
        if (!raw) { unmatched.targets_unknown_position++; unmatched.unknown_receivers.set(receiver, (unmatched.unknown_receivers.get(receiver) || 0) + 1); }
        else if (!pos) unmatched.targets_other_position++;
        else {
          const X = bump(position, `${dk}|${pos}`, newPosition);
          X.tgt++;
          if (air != null) X.air_yds += air;
          if (complete) { X.rec++; X.rec_yds += yards; if (flag(r.pass_touchdown)) X.rec_td++; }
        }
      }
    } else if (isScramble) {
      D.scrambles++; O.scrambles++; D.scramble_yds += yards;
      const qb = str(r.rusher_player_id);
      if (qb) { const P = bump(players, `${game}|${qb}`, newPlayer); P.scrambles++; P.scramble_yds += yards; }
    } else {
      // a designed run
      D.rush_att++; O.rush_att++; D.rush_yds += yards; O.rush_yds += yards;
      if (epa != null) D.rush_epa += epa;
      D.rush_success += success;
      if (yards >= 10) D.rush_10++;
      if (yards >= 20) D.rush_20++;
      if (yards <= 0) { D.rush_stuffed++; O.rush_stuffed++; }
      if (flag(r.first_down)) D.rush_fd++;
      if (flag(r.rush_touchdown)) D.rush_td++;
      if (yardline != null && yardline <= 20) D.rz_rush_att++;
      const rusher = str(r.rusher_player_id);
      if (rusher) {
        const P = bump(players, `${game}|${rusher}`, newPlayer);
        P.designed_runs++; P.rush_success += success;
        if (yards >= 10) P.rush_10++;
        if (yards >= 20) P.rush_20++;
        if (yardline != null && yardline <= 20) P.rz_carries++;
        if (yardline != null && yardline <= 5) P.gl_carries++;
        const raw = positionOf(rusher, week);
        if (!raw) unmatched.rb_carries_unknown_position++;
        if (positionGroup(raw) === "RB") {
          const X = bump(position, `${dk}|RB`, newPosition);
          X.car++; X.rush_yds += yards;
          if (flag(r.rush_touchdown)) X.rush_td++;
          O.rb_carries++; O.rb_rush_yds += yards;
        }
      }
    }
  }
  return { defense, offense, position, players, gameTeams, unmatched };
}

// ---------- per-game fact tables ----------

export function defenseGameRows(season, pbp) {
  const rows = [];
  for (const [key, facts] of pbp.defense) {
    const gt = pbp.gameTeams.get(key);
    const row = { season, week: gt.week, game_id: gt.game_id, team_id: gt.team_id, opponent_id: gt.opponent_id, ...facts };
    for (const k of ["db_epa", "rush_epa"]) row[k] = round(row[k], 5);
    for (const pos of DVP_POSITIONS) {
      const x = pbp.position.get(`${key}|${pos}`) || newPosition();
      const p = pos.toLowerCase();
      row[`${p}_tgt`] = x.tgt; row[`${p}_rec`] = x.rec; row[`${p}_rec_yds`] = x.rec_yds; row[`${p}_rec_td`] = x.rec_td; row[`${p}_air_yds`] = x.air_yds;
      if (pos === "RB") { row.rb_car = x.car; row.rb_rush_yds = x.rush_yds; row.rb_rush_td = x.rush_td; }
    }
    row.team_tgt = pbp.offense.get(`${gt.game_id}|${gt.opponent_id}`)?.team_targets ?? 0;
    rows.push(row);
  }
  return rows.sort((a, b) => a.week - b.week || a.game_id.localeCompare(b.game_id) || a.team_id.localeCompare(b.team_id));
}

export function teamWeekRows(season, pbp, teamStatRows) {
  const stats = new Map();
  for (const r of teamStatRows) { const t = normalizeTeam(r.team); if (t) stats.set(`${t}|${Number(r.week)}`, r); }
  const rows = [];
  for (const [key, f] of pbp.offense) {
    const gt = pbp.gameTeams.get(key);
    const s = stats.get(`${gt.team_id}|${gt.week}`) || {};
    rows.push({
      season, week: gt.week, game_id: gt.game_id, team_id: gt.team_id, opponent_id: gt.opponent_id,
      plays: f.plays, dropbacks: f.dropbacks, pass_att: f.pass_att, sacks_allowed: f.sacks, qb_hits_allowed: f.qb_hits, scrambles: f.scrambles,
      rush_att: f.rush_att, rush_yds: f.rush_yds, rush_stuffed: f.rush_stuffed, rb_carries: f.rb_carries, rb_rush_yds: f.rb_rush_yds,
      neutral_plays: f.neutral_plays, neutral_dropbacks: f.neutral_dropbacks, pass_oe_sum: round(f.pass_oe_sum, 3), pass_oe_n: f.pass_oe_n,
      team_targets: f.team_targets, team_air_yds: f.team_air_yds,
      // official box-score totals (carries include scrambles and kneels)
      box_attempts: num(s.attempts), box_completions: num(s.completions), box_passing_yards: num(s.passing_yards), box_carries: num(s.carries), box_rushing_yards: num(s.rushing_yards),
    });
  }
  return rows.sort((a, b) => a.week - b.week || a.game_id.localeCompare(b.game_id) || a.team_id.localeCompare(b.team_id));
}

/**
 * One row per skill player per game week.
 *
 * PLAYED, WITHOUT SNAP COUNTS:
 *   - a stat line with any offensive involvement, or an active roster status
 *     (ACT), counts as played;
 *   - a quarterback additionally needs at least one dropback, so a healthy
 *     backup who dressed and never took the field is not a zero-attempt game;
 *   - anyone else (inactive, reserve, practice squad) did not play, and his
 *     stats are NULL, not 0.
 * A player who played and has no stat line gets real zeros.
 */
export function playerWeekRows(season, games, rosterRows, playerStatRows, pbp) {
  const gameOf = new Map(); // team|week -> game
  for (const g of games) { gameOf.set(`${g.home_team_id}|${g.week}`, g); gameOf.set(`${g.away_team_id}|${g.week}`, g); }
  const stats = new Map();
  for (const r of playerStatRows) if (r.player_id) stats.set(`${r.player_id}|${Number(r.week)}`, r);
  const teamRbCarries = new Map(); // team|week -> carries by RB+FB (box score)
  const teamCarries = new Map(), teamTargets = new Map(), teamAir = new Map();
  for (const r of playerStatRows) {
    const t = normalizeTeam(r.team); if (!t) continue;
    const k = `${t}|${Number(r.week)}`;
    const car = num(r.carries) ?? 0;
    teamCarries.set(k, (teamCarries.get(k) || 0) + car);
    teamTargets.set(k, (teamTargets.get(k) || 0) + (num(r.targets) ?? 0));
    teamAir.set(k, (teamAir.get(k) || 0) + (num(r.receiving_air_yards) ?? 0));
    if (positionGroup(r.position) === "RB") teamRbCarries.set(k, (teamRbCarries.get(k) || 0) + car);
  }

  const out = new Map();
  const make = (playerId, week, teamId, position, rosterStatus) => {
    const game = gameOf.get(`${teamId}|${week}`);
    if (!game || game.status !== "final") return null; // bye, or not played yet
    const s = stats.get(`${playerId}|${week}`);
    const x = pbp.players.get(`${game.game_id}|${playerId}`);
    const involved = !!s && ((num(s.attempts) ?? 0) + (num(s.carries) ?? 0) + (num(s.targets) ?? 0) + (num(s.sacks_suffered) ?? 0) > 0);
    let played = involved || rosterStatus === "ACT";
    let reason = null;
    if (position === "QB" && !(x?.dropbacks > 0) && !involved) { played = false; reason = rosterStatus === "ACT" ? "active_did_not_play" : null; }
    if (!played && !reason) reason = { INA: "inactive", RES: "reserve", DEV: "practice_squad", CUT: "released", RET: "retired", EXE: "exempt" }[rosterStatus] || "not_active";
    const tk = `${teamId}|${week}`;
    const v = (f) => (played ? num(s?.[f]) ?? 0 : null);
    const carries = v("carries"), targets = v("targets"), air = played ? num(s?.receiving_air_yards) ?? 0 : null;
    return {
      season, week, game_id: game.game_id, player_id: playerId, team_id: teamId, opponent_id: game.home_team_id === teamId ? game.away_team_id : game.home_team_id,
      is_home: game.location === "neutral" ? null : game.home_team_id === teamId ? 1 : 0,
      position, roster_status: rosterStatus, played: played ? 1 : 0, not_played_reason: reason, has_stat_line: s ? 1 : 0,
      attempts: v("attempts"), completions: v("completions"), passing_yards: v("passing_yards"), passing_tds: v("passing_tds"), interceptions: v("passing_interceptions"),
      sacks: v("sacks_suffered"), passing_air_yards: v("passing_air_yards"), dropbacks: played ? x?.dropbacks ?? 0 : null, deep_attempts: played ? x?.deep_att ?? 0 : null,
      scrambles: played ? x?.scrambles ?? 0 : null, designed_runs: played ? x?.designed_runs ?? 0 : null,
      passing_epa: played ? round(num(s?.passing_epa), 4) : null,
      carries, rushing_yards: v("rushing_yards"), rushing_tds: v("rushing_tds"), rushing_epa: played ? round(num(s?.rushing_epa), 4) : null,
      rush_success: played ? x?.rush_success ?? 0 : null, runs_10plus: played ? x?.rush_10 ?? 0 : null, rz_carries: played ? x?.rz_carries ?? 0 : null, gl_carries: played ? x?.gl_carries ?? 0 : null,
      targets, receptions: v("receptions"), receiving_yards: v("receiving_yards"), receiving_tds: v("receiving_tds"), receiving_air_yards: air,
      receiving_yac: v("receiving_yards_after_catch"), receiving_epa: played ? round(num(s?.receiving_epa), 4) : null,
      rz_targets: played ? x?.rz_targets ?? 0 : null, short_targets: played ? x?.short_targets ?? 0 : null, receptions_20plus: played ? x?.rec_20 ?? 0 : null,
      // shares of the team's official totals in that game
      team_carries: teamCarries.get(tk) ?? null, team_rb_carries: teamRbCarries.get(tk) ?? null, team_targets: teamTargets.get(tk) ?? null, team_air_yards: teamAir.get(tk) ?? null,
      carry_share: played ? round(div(carries, teamCarries.get(tk) ?? 0)) : null,
      backfield_carry_share: played && positionGroup(position) === "RB" ? round(div(carries, teamRbCarries.get(tk) ?? 0)) : null,
      target_share: played ? round(div(targets, teamTargets.get(tk) ?? 0)) : null,
      air_yards_share: played ? round(div(air, teamAir.get(tk) ?? 0)) : null,
    };
  };

  for (const r of rosterRows) {
    if (!SKILL_POSITIONS.includes(r.position)) continue;
    if (!["ACT", "INA", "RES"].includes(r.status) && !stats.has(`${r.player_id}|${r.week}`)) continue;
    const row = make(r.player_id, r.week, r.team_id, r.position, r.status);
    if (row) out.set(`${r.player_id}|${r.week}`, row);
  }
  // a stat line for a skill player the weekly roster does not list that week
  let statOnly = 0;
  for (const r of playerStatRows) {
    const week = Number(r.week);
    if (!r.player_id || !SKILL_POSITIONS.includes(r.position) || out.has(`${r.player_id}|${week}`)) continue;
    const team = normalizeTeam(r.team);
    if (!team) continue;
    const row = make(r.player_id, week, team, r.position, null);
    if (row) { out.set(`${r.player_id}|${week}`, row); statOnly++; }
  }
  const rows = [...out.values()].sort((a, b) => a.week - b.week || a.team_id.localeCompare(b.team_id) || a.player_id.localeCompare(b.player_id));
  return { rows, statOnly };
}

// ---------- as-of aggregates (time-aware) ----------

const SUM_KEYS = Object.keys(newDefense());

/** Sums of a defense's per-game facts over games with week < asOfWeek. */
function defenseSums(defRows, asOfWeek) {
  const byTeam = new Map();
  for (const r of defRows) {
    if (r.week >= asOfWeek) continue; // the time-aware rule
    const s = bump(byTeam, r.team_id, () => ({ games: 0, opponents: [] }));
    s.games++;
    s.opponents.push({ week: r.week, opponent_id: r.opponent_id });
    for (const k of SUM_KEYS) s[k] = (s[k] || 0) + (r[k] || 0);
    for (const pos of DVP_POSITIONS) {
      const p = pos.toLowerCase();
      const x = (s[pos] ||= { games: 0, tgt: 0, rec: 0, rec_yds: 0, rec_td: 0, car: 0, rush_yds: 0, rush_td: 0, team_tgt: 0 });
      x.games++; x.tgt += r[`${p}_tgt`] || 0; x.rec += r[`${p}_rec`] || 0; x.rec_yds += r[`${p}_rec_yds`] || 0; x.rec_td += r[`${p}_rec_td`] || 0;
      x.team_tgt += r.team_tgt || 0;
      if (pos === "RB") { x.car += r.rb_car || 0; x.rush_yds += r.rb_rush_yds || 0; x.rush_td += r.rb_rush_td || 0; }
    }
  }
  return byTeam;
}

/**
 * Defensive metrics entering `asOfWeek`: value, league average, rank (1 =
 * strongest) and strength percentile for every team and metric.
 * Uses only games with week < asOfWeek.
 */
export function defenseAsOf(season, defRows, asOfWeek) {
  const sums = defenseSums(defRows, asOfWeek);
  const rows = [];
  for (const m of DEFENSE_METRICS) {
    const { league_avg, teams } = rankMetric(m, sums);
    for (const [team, t] of teams) rows.push({ season, as_of_week: asOfWeek, team_id: team, sample_window: "season", metric_key: m.key, value: t.value, league_avg, rank: t.rank, percentile: t.percentile, games: sums.get(team).games, sample: t.sample, small_sample: t.small_sample ? 1 : 0 });
  }
  const positionRows = [];
  for (const pos of DVP_POSITIONS) {
    const posSums = new Map([...sums].map(([team, s]) => [team, s[pos]]));
    for (const m of POSITION_METRICS) {
      if (m.only && !m.only.includes(pos)) continue;
      const { league_avg, teams } = rankMetric(m, posSums);
      for (const [team, t] of teams) positionRows.push({ season, as_of_week: asOfWeek, team_id: team, position: pos, sample_window: "season", metric_key: m.key, value: t.value, league_avg, rank: t.rank, percentile: t.percentile, games: sums.get(team).games, sample: t.sample, small_sample: t.small_sample ? 1 : 0 });
    }
  }
  const opponents = new Map([...sums].map(([team, s]) => [team, s.opponents.sort((a, b) => a.week - b.week)]));
  return { rows, positionRows, opponents, teams: sums.size };
}

const USAGE_SUMS = ["attempts", "completions", "passing_yards", "passing_tds", "interceptions", "sacks", "dropbacks", "deep_attempts", "passing_air_yards", "scrambles", "designed_runs",
  "carries", "rushing_yards", "rushing_tds", "rush_success", "runs_10plus", "rz_carries", "gl_carries",
  "targets", "receptions", "receiving_yards", "receiving_tds", "receiving_air_yards", "receiving_yac", "rz_targets", "short_targets", "receptions_20plus",
  "team_carries", "team_rb_carries", "team_targets", "team_air_yards"];

/**
 * A player's usage entering `asOfWeek`, over three windows of games PLAYED:
 * the season to date, his last 5 and his last 3. Uses only week < asOfWeek.
 * Shares are sums over the window (his targets / his team's targets in those
 * games), not an average of weekly shares.
 */
export function usageAsOf(season, playerWeeks, asOfWeek) {
  const byPlayer = new Map();
  for (const r of playerWeeks) {
    if (r.week >= asOfWeek || !r.played) continue; // the time-aware rule; unplayed weeks are not games
    bump(byPlayer, r.player_id, () => []).push(r);
  }
  const rows = [];
  for (const [playerId, list] of byPlayer) {
    list.sort((a, b) => a.week - b.week);
    const last = list[list.length - 1];
    for (const [sampleWindow, games] of [["season", list], ["L5", list.slice(-5)], ["L3", list.slice(-3)]]) {
      const s = Object.fromEntries(USAGE_SUMS.map((k) => [k, games.reduce((a, g) => a + (g[k] ?? 0), 0)]));
      const n = games.length;
      const pg = (k) => round(s[k] / n, 3);
      rows.push({
        season, as_of_week: asOfWeek, player_id: playerId, team_id: last.team_id, position: last.position, sample_window: sampleWindow, games: n,
        first_week: games[0].week, last_week: games[n - 1].week,
        attempts_pg: pg("attempts"), completions_pg: pg("completions"), passing_yards_pg: pg("passing_yards"), dropbacks_pg: pg("dropbacks"),
        ypa: round(div(s.passing_yards, s.attempts), 3), completion_pct: round(div(s.completions, s.attempts)), pass_adot: round(div(s.passing_air_yards, s.attempts), 3),
        deep_attempt_rate: round(div(s.deep_attempts, s.attempts)), sack_rate: round(div(s.sacks, s.dropbacks)), scramble_rate: round(div(s.scrambles, s.dropbacks)),
        carries_pg: pg("carries"), rushing_yards_pg: pg("rushing_yards"), ypc: round(div(s.rushing_yards, s.carries), 3),
        rush_success_rate: round(div(s.rush_success, s.designed_runs)), explosive_run_rate: round(div(s.runs_10plus, s.designed_runs)),
        carry_share: round(div(s.carries, s.team_carries)), backfield_carry_share: positionGroup(last.position) === "RB" ? round(div(s.carries, s.team_rb_carries)) : null,
        rz_carries: s.rz_carries, gl_carries: s.gl_carries,
        targets_pg: pg("targets"), receptions_pg: pg("receptions"), receiving_yards_pg: pg("receiving_yards"),
        target_share: round(div(s.targets, s.team_targets)), air_yards_share: round(div(s.receiving_air_yards, s.team_air_yards)),
        adot: round(div(s.receiving_air_yards, s.targets), 3), catch_rate: round(div(s.receptions, s.targets)), yards_per_target: round(div(s.receiving_yards, s.targets), 3),
        yards_per_reception: round(div(s.receiving_yards, s.receptions), 3), yac_per_reception: round(div(s.receiving_yac, s.receptions), 3),
        short_target_share: round(div(s.short_targets, s.targets)), receptions_20plus: s.receptions_20plus, rz_targets: s.rz_targets,
        touches_pg: round((s.carries + s.receptions) / n, 3),
      });
    }
  }
  return rows.sort((a, b) => a.player_id.localeCompare(b.player_id) || a.sample_window.localeCompare(b.sample_window));
}

/** Team offensive tendencies entering `asOfWeek` (week < asOfWeek only). */
export function tendenciesAsOf(season, teamWeeks, asOfWeek) {
  const byTeam = new Map();
  for (const r of teamWeeks) {
    if (r.week >= asOfWeek) continue;
    const s = bump(byTeam, r.team_id, () => ({ games: 0, plays: 0, dropbacks: 0, rush_att: 0, neutral_plays: 0, neutral_dropbacks: 0, pass_oe_sum: 0, pass_oe_n: 0, pass_att: 0, sacks_allowed: 0, qb_hits_allowed: 0, rush_stuffed: 0, rb_carries: 0, rb_rush_yds: 0 }));
    s.games++;
    for (const k of Object.keys(s)) if (k !== "games") s[k] += r[k] || 0;
  }
  const league = { plays: 0, dropbacks: 0, games: 0, neutral_plays: 0, neutral_dropbacks: 0 };
  for (const s of byTeam.values()) for (const k of Object.keys(league)) league[k] += s[k];
  const rows = [];
  for (const [team, s] of byTeam) {
    rows.push({
      season, as_of_week: asOfWeek, team_id: team, games: s.games,
      plays_pg: round(s.plays / s.games, 2), pass_rate: round(div(s.dropbacks, s.plays)), rush_rate: round(div(s.plays - s.dropbacks, s.plays)),
      neutral_pass_rate: round(div(s.neutral_dropbacks, s.neutral_plays)), neutral_plays: s.neutral_plays,
      pass_rate_over_expected: round(div(s.pass_oe_sum, s.pass_oe_n), 3),
      pass_att_pg: round(s.pass_att / s.games, 2), rush_att_pg: round(s.rush_att / s.games, 2),
      sack_rate_allowed: round(div(s.sacks_allowed, s.dropbacks)), qb_hit_rate_allowed: round(div(s.qb_hits_allowed, s.dropbacks)),
      stuff_rate_allowed: round(div(s.rush_stuffed, s.rush_att)), rb_ypc: round(div(s.rb_rush_yds, s.rb_carries), 3),
      league_plays_pg: round(div(league.plays, league.games), 2), league_pass_rate: round(div(league.dropbacks, league.plays)), league_neutral_pass_rate: round(div(league.neutral_dropbacks, league.neutral_plays)),
    });
  }
  return rows.sort((a, b) => a.team_id.localeCompare(b.team_id));
}

// ---------- injuries, depth charts, environment ----------

const PRACTICE = { "full participation in practice": "FULL", "limited participation in practice": "LIMITED", "did not participate in practice": "DNP" };
const GAME_STATUS = { out: "OUT", doubtful: "DOUBTFUL", questionable: "QUESTIONABLE" };

/**
 * The official report as nflverse publishes it: one row per player per week
 * holding the latest status. The source has no per-day history and no report
 * timestamp, so `reported_at` is null and `captured_date` (the day PWR read
 * it) is what builds the day-by-day practice ladder over successive builds.
 * A status string this map does not know is kept raw with status UNKNOWN.
 */
export function injuryRows(season, injuryRowsRaw, capturedDate) {
  const rows = [];
  const unknown = new Map();
  for (const r of injuryRowsRaw) {
    if (Number(r.season) !== season || !r.gsis_id) continue;
    const team = normalizeTeam(r.team);
    if (!team) continue;
    const gameRaw = str(r.report_status), practiceRaw = str(r.practice_status);
    const game = gameRaw ? GAME_STATUS[gameRaw.toLowerCase()] || "UNKNOWN" : null;
    const practice = practiceRaw ? PRACTICE[practiceRaw.toLowerCase()] || "UNKNOWN" : null;
    if (game === "UNKNOWN") unknown.set(gameRaw, (unknown.get(gameRaw) || 0) + 1);
    if (practice === "UNKNOWN") unknown.set(practiceRaw, (unknown.get(practiceRaw) || 0) + 1);
    rows.push({
      season, week: Number(r.week), team_id: team, player_id: r.gsis_id, position: str(r.position), display_name: str(r.full_name),
      game_status: game, game_status_raw: gameRaw, practice_status: practice, practice_status_raw: practiceRaw,
      report_primary_injury: str(r.report_primary_injury), report_secondary_injury: str(r.report_secondary_injury),
      practice_primary_injury: str(r.practice_primary_injury), practice_secondary_injury: str(r.practice_secondary_injury),
      reported_at: str(r.date_modified), captured_date: capturedDate, source: "nflverse:injuries",
    });
  }
  return { rows, unknown };
}

/** The most recent depth-chart snapshot of each team. */
export function depthChartRows(season, rows) {
  const latest = new Map();
  for (const r of rows) { const t = normalizeTeam(r.team); if (t && (!latest.has(t) || r.dt > latest.get(t))) latest.set(t, r.dt); }
  const out = [];
  for (const r of rows) {
    const t = normalizeTeam(r.team);
    if (!t || r.dt !== latest.get(t) || !r.gsis_id) continue;
    out.push({ season, team_id: t, snapshot_at: r.dt, player_id: r.gsis_id, display_name: str(r.player_name), pos_group: str(r.pos_grp), pos_name: str(r.pos_name), pos_abb: str(r.pos_abb), pos_slot: num(r.pos_slot), pos_rank: num(r.pos_rank) });
  }
  return out.sort((a, b) => a.team_id.localeCompare(b.team_id) || String(a.pos_abb).localeCompare(String(b.pos_abb)) || (a.pos_slot ?? 0) - (b.pos_slot ?? 0) || (a.pos_rank ?? 0) - (b.pos_rank ?? 0));
}

/**
 * Game context for this week's games not yet played, as known on `capturedDate`.
 * Later weeks get their rows when their week arrives, with tendencies through
 * the week before; nothing is written ahead with stale tendencies.
 * Spread, total and implied totals come from the schedule file's lines.
 * Weather columns exist and stay NULL until a licensed provider is connected.
 */
export function environmentRows(games, tendencies, asOfWeek, capturedDate) {
  const tend = new Map(tendencies.map((t) => [t.team_id, t]));
  return games.filter((g) => g.status !== "final" && g.week === asOfWeek).map((g) => {
    const h = tend.get(g.home_team_id) || {}, a = tend.get(g.away_team_id) || {};
    return {
      game_id: g.game_id, season: g.season, week: g.week, captured_date: capturedDate, as_of_week: asOfWeek,
      kickoff_utc: g.kickoff_utc, home_team_id: g.home_team_id, away_team_id: g.away_team_id, location: g.location, stadium: g.stadium, roof: g.roof, surface: g.surface,
      home_rest: g.home_rest, away_rest: g.away_rest,
      spread_line: g.spread_line, total_line: g.total_line, home_implied_total: g.home_implied_total, away_implied_total: g.away_implied_total, lines_source: "nflverse:schedule",
      home_plays_pg: h.plays_pg ?? null, home_pass_rate: h.pass_rate ?? null, home_neutral_pass_rate: h.neutral_pass_rate ?? null, home_proe: h.pass_rate_over_expected ?? null,
      away_plays_pg: a.plays_pg ?? null, away_pass_rate: a.pass_rate ?? null, away_neutral_pass_rate: a.neutral_pass_rate ?? null, away_proe: a.pass_rate_over_expected ?? null,
      weather_temperature_f: null, weather_wind_mph: null, weather_gust_mph: null, weather_precip_probability: null, weather_precip_in: null, weather_updated_at: null, weather_source: null,
    };
  });
}
