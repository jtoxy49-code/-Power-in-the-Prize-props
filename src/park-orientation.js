/**
 * Approximate compass bearing (0=N, 90=E, 180=S, 270=W) from home
 * plate toward dead center field, for every MLB park. This is
 * architectural/geographic fact (unlike park factors), but exact
 * degree values here are still best-effort from general knowledge,
 * not verified against an official source — treat as approximate.
 */
export const PARK_CF_AZIMUTH = {
  "Arizona Diamondbacks": 5,
  "Atlanta Braves": 15,
  "Baltimore Orioles": 30,
  "Boston Red Sox": 40,
  "Chicago Cubs": 30,
  "Chicago White Sox": 135,
  "Cincinnati Reds": 90,
  "Cleveland Guardians": 0,
  "Colorado Rockies": 20,
  "Detroit Tigers": 155,
  "Houston Astros": 345,
  "Kansas City Royals": 45,
  "Los Angeles Angels": 30,
  "Los Angeles Dodgers": 15,
  "Miami Marlins": 40,
  "Milwaukee Brewers": 135,
  "Minnesota Twins": 90,
  "New York Mets": 30,
  "New York Yankees": 75,
  "Athletics": 45,
  "Philadelphia Phillies": 5,
  "Pittsburgh Pirates": 315,
  "San Diego Padres": 5,
  "San Francisco Giants": 95,
  "Seattle Mariners": 45,
  "St. Louis Cardinals": 90,
  "Tampa Bay Rays": 45,
  "Texas Rangers": 30,
  "Toronto Blue Jays": 0,
  "Washington Nationals": 35,
};

/**
 * Normalizes an angle difference into the range -180..180.
 */
function normalizeAngle(deg) {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

/**
 * Classifies wind relative to a specific park's orientation into a
 * human-readable label ("Out to LCF", "In from CF", etc.), matching
 * the reference site's wind display. Best-effort given approximate
 * park orientation data above.
 */
export function classifyWindForPark(teamName, windDirectionDeg, windMph) {
  const cfAzimuth = PARK_CF_AZIMUTH[teamName];
  if (cfAzimuth == null || windDirectionDeg == null) return null;

  if (windMph != null && windMph < 5) {
    return { label: "Calm", relative_angle_deg: null };
  }

  // wind_direction_deg is where the wind is blowing FROM (met. convention);
  // the wind actually travels toward the opposite compass point.
  const travelAzimuth = (windDirectionDeg + 180) % 360;
  const relative = normalizeAngle(travelAzimuth - cfAzimuth);

  let label;
  if (relative >= -22.5 && relative < 22.5) label = "Out to CF";
  else if (relative >= 22.5 && relative < 67.5) label = "Out to RCF";
  else if (relative >= 67.5 && relative < 112.5) label = "Crosswind toward RF line";
  else if (relative >= 112.5 && relative < 157.5) label = "In from RCF";
  else if (relative >= 157.5 || relative < -157.5) label = "In from CF";
  else if (relative >= -157.5 && relative < -112.5) label = "In from LCF";
  else if (relative >= -112.5 && relative < -67.5) label = "Crosswind toward LF line";
  else label = "Out to LCF"; // -67.5 to -22.5

  return { label, relative_angle_deg: +relative.toFixed(0) };
}
