// NFL normalization: teams and players. Every external spelling goes through
// one table; an unknown or ambiguous one resolves to nothing, never to a guess.
import test from "node:test";
import assert from "node:assert/strict";
import { NFL_TEAMS, normalizeTeam, isTeamId } from "../src/nfl/teams.js";
import { nameKey, resolvePlayer, rosterNameKeys, sameFirstName } from "../src/nfl/players.js";
import { loadSource, loadOddsRows, derive } from "./fixtures/nfl/load.mjs";

test("the team table has 32 clubs, each with id, abbreviation, city, nickname and display name", () => {
  assert.equal(NFL_TEAMS.length, 32);
  for (const t of NFL_TEAMS) for (const f of ["team_id", "abbreviation", "city", "nickname", "display_name", "conference", "division"]) assert.ok(t[f], `${t.team_id}.${f}`);
  assert.equal(new Set(NFL_TEAMS.map((t) => t.team_id)).size, 32);
});

test("abbreviation differences between sources resolve to one team_id", () => {
  const cases = { LA: "LA", LAR: "LA", LAC: "LAC", JAX: "JAX", JAC: "JAX", WAS: "WAS", WSH: "WAS", LV: "LV", LVR: "LV", OAK: "LV", NYG: "NYG", NYJ: "NYJ", GB: "GB", GNB: "GB", KC: "KC", KAN: "KC", NE: "NE", NWE: "NE", NO: "NO", NOR: "NO", SF: "SF", SFO: "SF", TB: "TB", TAM: "TB", SD: "LAC", STL: "LA", HST: "HOU", BLT: "BAL", CLV: "CLE", ARZ: "ARI" };
  for (const [input, want] of Object.entries(cases)) assert.equal(normalizeTeam(input), want, input);
  assert.equal(normalizeTeam("lar"), "LA", "case does not matter");
});

test("names, nicknames and the odds feed's mixed spellings resolve", () => {
  assert.equal(normalizeTeam("Arizona Cardinals"), "ARI");
  assert.equal(normalizeTeam("ARI Cardinals"), "ARI", "seen on DraftKings rows in the 2026-10-02 probe");
  assert.equal(normalizeTeam("Commanders"), "WAS");
  assert.equal(normalizeTeam("NY Giants"), "NYG");
  assert.equal(normalizeTeam("NY Jets"), "NYJ");
  assert.equal(normalizeTeam("LA Rams"), "LA");
  assert.equal(normalizeTeam("LA Chargers"), "LAC");
  assert.equal(normalizeTeam("LVR Raiders"), "LV");
  assert.equal(normalizeTeam("washington_commanders"), "WAS", "provider id form");
  assert.equal(normalizeTeam({ id: "indianapolis_colts", name: "Indianapolis Colts", abbreviation: "IND" }), "IND", "the feed's home/away object");
  assert.equal(normalizeTeam({ abbreviation: "WSH", name: "Washington Commanders" }), "WAS");
});

test("an unknown or ambiguous team spelling resolves to null, never to a guess", () => {
  for (const input of ["New York", "Los Angeles", "NY", "XYZ", "", null, undefined, "Red Sox"]) assert.equal(normalizeTeam(input), null, String(input));
  assert.equal(isTeamId("LAR"), false);
  assert.equal(isTeamId("LA"), true);
});

test("every team code in the real 2026 schedule, rosters and play-by-play is known", () => {
  const { source } = loadSource();
  const codes = new Set([...source.schedule.flatMap((g) => [g.home_team, g.away_team]), ...source.roster_weekly.map((r) => r.team), ...source.pbp.flatMap((p) => [p.posteam, p.defteam]).filter((c) => c && c !== "NA")]);
  const unknown = [...codes].filter((c) => !normalizeTeam(c));
  assert.deepEqual(unknown, []);
});

test("a name key ignores accents, case, punctuation and suffixes", () => {
  assert.equal(nameKey("Amon-Ra St. Brown"), "amon ra st brown");
  assert.equal(nameKey("Ja'Marr Chase"), "jamarr chase");
  assert.equal(nameKey("A.J. Brown"), "aj brown");
  assert.equal(nameKey("Michael Pittman Jr."), "michael pittman");
  assert.equal(nameKey("Marvin Harrison Jr"), nameKey("Marvin Harrison"));
  assert.equal(nameKey("José Ramírez"), "jose ramirez");
});

const P = (id, display, pos = "WR", extra = {}) => ({ player_id: id, display_name: display, position: pos, ...extra });

test("exact match wins and reports its method", () => {
  const pool = [P("1", "Terry McLaurin"), P("2", "Deebo Samuel")];
  assert.deepEqual(resolvePlayer("Terry McLaurin", pool), { player_id: "1", method: "exact" });
  assert.deepEqual(resolvePlayer("terry mclaurin jr.", pool), { player_id: "1", method: "exact" });
});

test("the roster's legal and football first names both count as exact", () => {
  const gainwell = P("00-0036919", "Kenny Gainwell", "RB", { first_name: "Kenneth", last_name: "Gainwell" });
  assert.ok(rosterNameKeys(gainwell).includes("kenneth gainwell"));
  assert.equal(resolvePlayer("Kenneth Gainwell", [gainwell]).player_id, "00-0036919");
});

test("first-name variants resolve generally, not only the two cases the probe found", () => {
  assert.ok(sameFirstName("kenneth", "kenny") && sameFirstName("cameron", "cam") && sameFirstName("joshua", "josh") && sameFirstName("christopher", "chris"));
  assert.ok(!sameFirstName("kenneth", "cam"));
  assert.deepEqual(resolvePlayer("Cameron Skattebo", [P("7", "Cam Skattebo", "RB")]), { player_id: "7", method: "variant" });
  assert.deepEqual(resolvePlayer("Josh Palmer", [P("8", "Joshua Palmer")]), { player_id: "8", method: "variant" });
  assert.deepEqual(resolvePlayer("Gabe Davis", [P("9", "Gabriel Davis")]), { player_id: "9", method: "variant" });
});

test("an initial-and-last-name short form resolves only when it is unique", () => {
  assert.deepEqual(resolvePlayer("T McLaurin", [P("1", "Terry McLaurin"), P("2", "Deebo Samuel")]), { player_id: "1", method: "initial" });
});

test("an ambiguous name is rejected, never matched to one of the candidates", () => {
  const twins = [P("1", "Josh Allen", "QB"), P("2", "Josh Allen", "LB")];
  const out = resolvePlayer("Josh Allen", twins);
  assert.equal(out.player_id, null);
  assert.equal(out.reason, "ambiguous_exact");
  assert.equal(out.matches, 2);
  // two different players who share an initial and a last name
  const brothers = [P("3", "Jalen Carter"), P("4", "Jermaine Carter")];
  assert.equal(resolvePlayer("J. Carter", brothers).reason, "ambiguous_initial");
});

test("no match is reported as unresolved with its reason", () => {
  assert.deepEqual(resolvePlayer("Nobody Here", [P("1", "Terry McLaurin")]), { player_id: null, reason: "no_match", matches: 0 });
  assert.equal(resolvePlayer("", [P("1", "Terry McLaurin")]).reason, "empty_name");
});

test("a reviewed alias resolves only if that player is in the game", () => {
  const aliases = { "hollywood brown": { player_id: "55", source: "sharpapi", reviewed: "2026-10-02" } };
  assert.deepEqual(resolvePlayer("Hollywood Brown", [P("55", "Marquise Brown")], aliases).player_id, "55");
  assert.equal(resolvePlayer("Scooter Magee", [P("1", "Terry McLaurin")], { "scooter magee": { player_id: "99" } }).reason, "alias_not_in_game");
});

test("feed names resolve against the real rosters of the two teams in each game", () => {
  const { derived } = derive();
  const byTeam = new Map();
  for (const r of derived.rosters.filter((x) => x.week === derived.rosterWeek)) { if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []); byTeam.get(r.team_id).push(r); }
  const V1 = new Set(["player_passing_yards", "player_rushing_yards", "player_receiving_yards", "player_receptions"]);
  const seen = new Map();
  for (const row of loadOddsRows()) if (V1.has(row.market_type)) seen.set(`${row.event_id}|${row.player_name}`, row);
  let resolved = 0;
  const methods = {}, unresolved = [];
  for (const row of seen.values()) {
    const pool = [...(byTeam.get(normalizeTeam(row.home)) || []), ...(byTeam.get(normalizeTeam(row.away)) || [])].filter((p) => ["QB", "RB", "FB", "WR", "TE"].includes(p.position));
    const out = resolvePlayer(row.player_name, pool);
    if (out.player_id) { resolved++; methods[out.method] = (methods[out.method] || 0) + 1; } else unresolved.push(`${row.player_name}: ${out.reason}`);
  }
  assert.deepEqual(unresolved, [], "every V1 prop name resolves, including the two a book spells differently");
  assert.equal(resolved, seen.size);
  assert.ok(methods.exact >= seen.size - 5, "almost all are exact matches");
  assert.ok([...seen.values()].some((r) => r.player_name === "Kenneth Gainwell") && [...seen.values()].some((r) => r.player_name === "Cameron Skattebo"));
});
