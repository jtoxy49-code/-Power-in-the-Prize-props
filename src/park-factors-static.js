/**
 * STATIC, APPROXIMATE park factor reference table.
 *
 * These are directional, multi-year tendencies drawn from general
 * baseball knowledge — NOT live-computed current-season figures like
 * every other data source in this app. Baseball Savant's actual park
 * factors leaderboard is a client-rendered page with no accessible
 * raw-data export, so this is a deliberate, labeled substitute.
 *
 * Index style: 100 = league average. Above 100 = favors that outcome
 * more than average; below 100 = suppresses it. These should be
 * displayed in the UI with a clear "historical / approximate" label,
 * not styled identically to the live-data cards elsewhere on the site.
 *
 * KNOWN UNCERTAINTY — verify before relying on these two:
 *   - Athletics: playing at Sutter Health Park (West Sacramento), a
 *     smaller minor-league park, while their Las Vegas stadium is
 *     built. Factors here are a rough estimate for that venue, not
 *     their old Oakland Coliseum numbers.
 *   - Tampa Bay Rays: may still be at a temporary venue following
 *     hurricane damage to Tropicana Field's roof. Confirm current
 *     home venue before trusting this entry.
 */
export const PARK_FACTORS = {
  "Arizona Diamondbacks": { venue: "Chase Field", hr: 98, doubles_triples: 102, singles: 100, runs: 99 },
  "Atlanta Braves": { venue: "Truist Park", hr: 104, doubles_triples: 100, singles: 100, runs: 102 },
  "Baltimore Orioles": { venue: "Camden Yards", hr: 88, doubles_triples: 98, singles: 100, runs: 94 },
  "Boston Red Sox": { venue: "Fenway Park", hr: 92, doubles_triples: 118, singles: 102, runs: 104 },
  "Chicago Cubs": { venue: "Wrigley Field", hr: 106, doubles_triples: 100, singles: 99, runs: 103 },
  "Chicago White Sox": { venue: "Guaranteed Rate Field", hr: 112, doubles_triples: 98, singles: 99, runs: 105 },
  "Cincinnati Reds": { venue: "Great American Ball Park", hr: 118, doubles_triples: 97, singles: 99, runs: 108 },
  "Cleveland Guardians": { venue: "Progressive Field", hr: 97, doubles_triples: 99, singles: 100, runs: 98 },
  "Colorado Rockies": { venue: "Coors Field", hr: 116, doubles_triples: 128, singles: 108, runs: 122 },
  "Detroit Tigers": { venue: "Comerica Park", hr: 90, doubles_triples: 104, singles: 100, runs: 95 },
  "Houston Astros": { venue: "Daikin Park", hr: 105, doubles_triples: 97, singles: 99, runs: 101 },
  "Kansas City Royals": { venue: "Kauffman Stadium", hr: 88, doubles_triples: 108, singles: 101, runs: 96 },
  "Los Angeles Angels": { venue: "Angel Stadium", hr: 98, doubles_triples: 100, singles: 100, runs: 99 },
  "Los Angeles Dodgers": { venue: "Dodger Stadium", hr: 96, doubles_triples: 96, singles: 98, runs: 95 },
  "Miami Marlins": { venue: "loanDepot Park", hr: 89, doubles_triples: 98, singles: 99, runs: 92 },
  "Milwaukee Brewers": { venue: "American Family Field", hr: 108, doubles_triples: 100, singles: 100, runs: 104 },
  "Minnesota Twins": { venue: "Target Field", hr: 100, doubles_triples: 99, singles: 100, runs: 100 },
  "New York Mets": { venue: "Citi Field", hr: 94, doubles_triples: 99, singles: 100, runs: 97 },
  "New York Yankees": { venue: "Yankee Stadium", hr: 114, doubles_triples: 96, singles: 98, runs: 104 },
  "Athletics": { venue: "Sutter Health Park", hr: 108, doubles_triples: 100, singles: 100, runs: 103, note: "Temporary venue — verify" },
  "Philadelphia Phillies": { venue: "Citizens Bank Park", hr: 112, doubles_triples: 99, singles: 100, runs: 105 },
  "Pittsburgh Pirates": { venue: "PNC Park", hr: 90, doubles_triples: 100, singles: 100, runs: 95 },
  "San Diego Padres": { venue: "Petco Park", hr: 92, doubles_triples: 100, singles: 100, runs: 94 },
  "San Francisco Giants": { venue: "Oracle Park", hr: 84, doubles_triples: 106, singles: 100, runs: 92 },
  "Seattle Mariners": { venue: "T-Mobile Park", hr: 92, doubles_triples: 100, singles: 99, runs: 93 },
  "St. Louis Cardinals": { venue: "Busch Stadium", hr: 90, doubles_triples: 100, singles: 100, runs: 94 },
  "Tampa Bay Rays": { venue: "George M. Steinbrenner Field", hr: 106, doubles_triples: 100, singles: 100, runs: 102, note: "Temporary venue — verify" },
  "Texas Rangers": { venue: "Globe Life Field", hr: 96, doubles_triples: 98, singles: 100, runs: 96 },
  "Toronto Blue Jays": { venue: "Rogers Centre", hr: 100, doubles_triples: 99, singles: 100, runs: 100 },
  "Washington Nationals": { venue: "Nationals Park", hr: 98, doubles_triples: 100, singles: 100, runs: 99 },
};

/**
 * Looks up park factors by team name (home team). Returns null if
 * not found rather than guessing.
 */
export function getParkFactors(teamName) {
  return PARK_FACTORS[teamName] || null;
}
