/**
 * MLB venue coordinates — used to fetch weather for each game.
 * Geography is stable (unlike park factors), so no "approximate"
 * caveat needed here, beyond the same two venues flagged in
 * park-factors-static.js (Athletics, Rays) if they've moved.
 */
export const VENUE_COORDS = {
  "Arizona Diamondbacks": { lat: 33.4455, lon: -112.0667 },
  "Atlanta Braves": { lat: 33.8908, lon: -84.4678 },
  "Baltimore Orioles": { lat: 39.2839, lon: -76.6217 },
  "Boston Red Sox": { lat: 42.3467, lon: -71.0972 },
  "Chicago Cubs": { lat: 41.9484, lon: -87.6553 },
  "Chicago White Sox": { lat: 41.83, lon: -87.6338 },
  "Cincinnati Reds": { lat: 39.0979, lon: -84.5063 },
  "Cleveland Guardians": { lat: 41.4962, lon: -81.6852 },
  "Colorado Rockies": { lat: 39.7559, lon: -104.9942 },
  "Detroit Tigers": { lat: 42.339, lon: -83.0485 },
  "Houston Astros": { lat: 29.7573, lon: -95.3555 },
  "Kansas City Royals": { lat: 39.0517, lon: -94.4803 },
  "Los Angeles Angels": { lat: 33.8003, lon: -117.8827 },
  "Los Angeles Dodgers": { lat: 34.0739, lon: -118.24 },
  "Miami Marlins": { lat: 25.7781, lon: -80.2196 },
  "Milwaukee Brewers": { lat: 43.028, lon: -87.9712 },
  "Minnesota Twins": { lat: 44.9817, lon: -93.2777 },
  "New York Mets": { lat: 40.7571, lon: -73.8458 },
  "New York Yankees": { lat: 40.8296, lon: -73.9262 },
  "Athletics": { lat: 38.5802, lon: -121.5137 }, // Sutter Health Park — verify current venue
  "Philadelphia Phillies": { lat: 39.9061, lon: -75.1665 },
  "Pittsburgh Pirates": { lat: 40.4469, lon: -80.0057 },
  "San Diego Padres": { lat: 32.7073, lon: -117.1566 },
  "San Francisco Giants": { lat: 37.7786, lon: -122.3893 },
  "Seattle Mariners": { lat: 47.5914, lon: -122.3325 },
  "St. Louis Cardinals": { lat: 38.6226, lon: -90.1928 },
  "Tampa Bay Rays": { lat: 27.9799, lon: -82.5065 }, // Steinbrenner Field — verify current venue
  "Texas Rangers": { lat: 32.7473, lon: -97.0847 },
  "Toronto Blue Jays": { lat: 43.6414, lon: -79.3894 },
  "Washington Nationals": { lat: 38.873, lon: -77.0074 },
};

export function getVenueCoords(teamName) {
  return VENUE_COORDS[teamName] || null;
}
