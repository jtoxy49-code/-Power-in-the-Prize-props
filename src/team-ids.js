/**
 * MLB's stable numeric team IDs (used by the Stats API's schedule
 * endpoint, which needs a teamId, not a name).
 */
export const TEAM_IDS = {
  "Los Angeles Angels": 108,
  "Arizona Diamondbacks": 109,
  "Baltimore Orioles": 110,
  "Boston Red Sox": 111,
  "Chicago Cubs": 112,
  "Cincinnati Reds": 113,
  "Cleveland Guardians": 114,
  "Colorado Rockies": 115,
  "Detroit Tigers": 116,
  "Houston Astros": 117,
  "Kansas City Royals": 118,
  "Los Angeles Dodgers": 119,
  "Washington Nationals": 120,
  "New York Mets": 121,
  "Athletics": 133,
  "Pittsburgh Pirates": 134,
  "San Diego Padres": 135,
  "Seattle Mariners": 136,
  "San Francisco Giants": 137,
  "St. Louis Cardinals": 138,
  "Tampa Bay Rays": 139,
  "Texas Rangers": 140,
  "Toronto Blue Jays": 141,
  "Minnesota Twins": 142,
  "Philadelphia Phillies": 143,
  "Atlanta Braves": 144,
  "Chicago White Sox": 145,
  "Miami Marlins": 146,
  "New York Yankees": 147,
  "Milwaukee Brewers": 158,
};

export function getTeamId(teamName) {
  return TEAM_IDS[teamName] || null;
}

/**
 * Savant's own team abbreviations (used by statcast_search's team=
 * filter) — confirmed values in bold below came from real data we
 * pulled (LAA, PIT, CHC, CIN, MIL, WSH); the rest are the standard
 * MLB abbreviations, unverified against Savant specifically.
 */
export const TEAM_ABBREVIATIONS = {
  "Los Angeles Angels": "LAA",
  "Arizona Diamondbacks": "AZ",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",
  "Cincinnati Reds": "CIN",
  "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Kansas City Royals": "KC",
  "Los Angeles Dodgers": "LAD",
  "Washington Nationals": "WSH",
  "New York Mets": "NYM",
  "Athletics": "ATH",
  "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD",
  "Seattle Mariners": "SEA",
  "San Francisco Giants": "SF",
  "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",
  "Toronto Blue Jays": "TOR",
  "Minnesota Twins": "MIN",
  "Philadelphia Phillies": "PHI",
  "Atlanta Braves": "ATL",
  "Chicago White Sox": "CWS",
  "Miami Marlins": "MIA",
  "New York Yankees": "NYY",
  "Milwaukee Brewers": "MIL",
};

export function getTeamAbbreviation(teamName) {
  return TEAM_ABBREVIATIONS[teamName] || null;
}
