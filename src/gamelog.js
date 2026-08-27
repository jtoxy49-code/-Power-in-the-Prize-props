const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

/**
 * Fetches one pitcher's game-by-game log for a season. Called
 * on-demand (when someone views that pitcher's detail page), not on
 * a cron — pre-fetching this for 800+ pitchers would blow past
 * Workers' per-invocation subrequest limits.
 */
export async function fetchGameLog(playerId, year) {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${year}&sportId=1`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`MLB Stats API gameLog fetch failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Returns a KV-cached game log for a player, refetching only if the
 * cache is missing or older than 3 hours (game logs only change once
 * a game finishes, so this doesn't need to be fresh-fresh).
 */
export async function getCachedGameLog(env, playerId, year) {
  const cacheKey = `gamelog:${playerId}:${year}`;
  const cached = await env.PROPS_DATA.get(cacheKey, "json");

  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 3 * 60 * 60 * 1000) {
      return cached;
    }
  }

  const raw = await fetchGameLog(playerId, year);
  const splits = raw?.stats?.[0]?.splits || [];

  const result = {
    games: splits,
    fetched_at: new Date().toISOString(),
  };

  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), {
    expirationTtl: 6 * 60 * 60, // auto-expire after 6 hours regardless
  });

  return result;
}
