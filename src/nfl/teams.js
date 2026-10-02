// NFL NORMALIZATION: the one canonical team table.
//
// team_id is the nflverse abbreviation (the Rams are LA, the Raiders LV,
// Washington WAS, Jacksonville JAX). Every external source is normalized
// through normalizeTeam(); nothing downstream joins on a team name.
//
// A spelling this table does not know resolves to null. It is never guessed.

export const NFL_TEAMS = [
  { team_id: "ARI", city: "Arizona", nickname: "Cardinals", conference: "NFC", division: "West" },
  { team_id: "ATL", city: "Atlanta", nickname: "Falcons", conference: "NFC", division: "South" },
  { team_id: "BAL", city: "Baltimore", nickname: "Ravens", conference: "AFC", division: "North" },
  { team_id: "BUF", city: "Buffalo", nickname: "Bills", conference: "AFC", division: "East" },
  { team_id: "CAR", city: "Carolina", nickname: "Panthers", conference: "NFC", division: "South" },
  { team_id: "CHI", city: "Chicago", nickname: "Bears", conference: "NFC", division: "North" },
  { team_id: "CIN", city: "Cincinnati", nickname: "Bengals", conference: "AFC", division: "North" },
  { team_id: "CLE", city: "Cleveland", nickname: "Browns", conference: "AFC", division: "North" },
  { team_id: "DAL", city: "Dallas", nickname: "Cowboys", conference: "NFC", division: "East" },
  { team_id: "DEN", city: "Denver", nickname: "Broncos", conference: "AFC", division: "West" },
  { team_id: "DET", city: "Detroit", nickname: "Lions", conference: "NFC", division: "North" },
  { team_id: "GB", city: "Green Bay", nickname: "Packers", conference: "NFC", division: "North" },
  { team_id: "HOU", city: "Houston", nickname: "Texans", conference: "AFC", division: "South" },
  { team_id: "IND", city: "Indianapolis", nickname: "Colts", conference: "AFC", division: "South" },
  { team_id: "JAX", city: "Jacksonville", nickname: "Jaguars", conference: "AFC", division: "South" },
  { team_id: "KC", city: "Kansas City", nickname: "Chiefs", conference: "AFC", division: "West" },
  { team_id: "LA", city: "Los Angeles", nickname: "Rams", conference: "NFC", division: "West" },
  { team_id: "LAC", city: "Los Angeles", nickname: "Chargers", conference: "AFC", division: "West" },
  { team_id: "LV", city: "Las Vegas", nickname: "Raiders", conference: "AFC", division: "West" },
  { team_id: "MIA", city: "Miami", nickname: "Dolphins", conference: "AFC", division: "East" },
  { team_id: "MIN", city: "Minnesota", nickname: "Vikings", conference: "NFC", division: "North" },
  { team_id: "NE", city: "New England", nickname: "Patriots", conference: "AFC", division: "East" },
  { team_id: "NO", city: "New Orleans", nickname: "Saints", conference: "NFC", division: "South" },
  { team_id: "NYG", city: "New York", nickname: "Giants", conference: "NFC", division: "East" },
  { team_id: "NYJ", city: "New York", nickname: "Jets", conference: "AFC", division: "East" },
  { team_id: "PHI", city: "Philadelphia", nickname: "Eagles", conference: "NFC", division: "East" },
  { team_id: "PIT", city: "Pittsburgh", nickname: "Steelers", conference: "AFC", division: "North" },
  { team_id: "SEA", city: "Seattle", nickname: "Seahawks", conference: "NFC", division: "West" },
  { team_id: "SF", city: "San Francisco", nickname: "49ers", conference: "NFC", division: "West" },
  { team_id: "TB", city: "Tampa Bay", nickname: "Buccaneers", conference: "NFC", division: "South" },
  { team_id: "TEN", city: "Tennessee", nickname: "Titans", conference: "AFC", division: "South" },
  { team_id: "WAS", city: "Washington", nickname: "Commanders", conference: "NFC", division: "East" },
].map((t) => ({ ...t, abbreviation: t.team_id, display_name: `${t.city} ${t.nickname}` }));

export const TEAM_BY_ID = Object.fromEntries(NFL_TEAMS.map((t) => [t.team_id, t]));
export const isTeamId = (id) => Object.prototype.hasOwnProperty.call(TEAM_BY_ID, id);

// Abbreviations other sources use for the same club. LAR and LVR were seen from
// the odds provider on NFL game lines; WSH and JAC are ESPN's and older
// feeds'. HST, BLT, CLV, ARZ are the NFL's own gamebook codes.
const ABBREVIATION_ALIASES = {
  LAR: "LA", RAM: "LA", STL: "LA",
  LVR: "LV", OAK: "LV", RAI: "LV",
  WSH: "WAS", WFT: "WAS",
  JAC: "JAX",
  GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB",
  SD: "LAC", SDG: "LAC",
  HST: "HOU", BLT: "BAL", CLV: "CLE", ARZ: "ARI",
};

const key = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Every accepted spelling, built once: abbreviation, alias abbreviation, full
// name, nickname alone (unique among the 32), and "<abbreviation> <nickname>"
// (the odds feed sends "ARI Cardinals" on some rows).
const LOOKUP = new Map();
const add = (spelling, teamId) => {
  const k = key(spelling);
  if (!k) return;
  if (LOOKUP.has(k) && LOOKUP.get(k) !== teamId) throw new Error(`NFL team alias "${spelling}" is ambiguous`);
  LOOKUP.set(k, teamId);
};
for (const t of NFL_TEAMS) {
  add(t.team_id, t.team_id);
  add(t.display_name, t.team_id);
  add(t.nickname, t.team_id);
  add(`${t.team_id} ${t.nickname}`, t.team_id);
  add(`${t.city}_${t.nickname}`, t.team_id); // provider ids such as "washington_commanders"
}
for (const [alias, teamId] of Object.entries(ABBREVIATION_ALIASES)) {
  add(alias, teamId);
  add(`${alias} ${TEAM_BY_ID[teamId].nickname}`, teamId);
}
// City short forms that are unambiguous. "New York" and "Los Angeles" alone are
// not teams and are deliberately absent.
add("NY Giants", "NYG"); add("NY Jets", "NYJ");
add("LA Rams", "LA"); add("LA Chargers", "LAC");
add("Washington Football Team", "WAS"); add("Washington Redskins", "WAS");
add("Oakland Raiders", "LV"); add("San Diego Chargers", "LAC"); add("St. Louis Rams", "LA");

/**
 * Any source's spelling of a team to the canonical team_id, or null.
 * Accepts abbreviations (LAR, JAC, WSH), full names, nicknames and
 * "<abbr> <nickname>". A bare city shared by two clubs returns null.
 */
export function normalizeTeam(input) {
  if (input == null) return null;
  if (typeof input === "object") return normalizeTeam(input.abbreviation) || normalizeTeam(input.name) || normalizeTeam(input.id);
  return LOOKUP.get(key(input)) || null;
}
