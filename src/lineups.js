const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

/**
 * Fetches confirmed starting lineups for every MLB game on a given
 * date. Lineups typically confirm ~1-2 hours before first pitch, so
 * this is fetched fresh rather than cached long-term.
 */
export async function fetchLineupsForDate(date) {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${date}&hydrate=lineups,probablePitcher,team`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`MLB Stats API schedule/lineups fetch failed: ${res.status}`);
  }

  return res.json();
}
