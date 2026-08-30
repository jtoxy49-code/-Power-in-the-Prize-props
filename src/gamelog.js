const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

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
 * Confirmed field mapping (verified against real 2026 data):
 * each split has stat{}, team{}, opponent{}, date, isHome, isWin.
 */
function cleanGame(split) {
  const s = split.stat || {};
  return {
    date: split.date,
    opponent: split.opponent?.name || "",
    is_home: !!split.isHome,
    win: !!split.isWin,
    innings_pitched: s.inningsPitched ?? null,
    outs: Number(s.outs) || 0,
    strikeouts: Number(s.strikeOuts) || 0,
    walks: Number(s.baseOnBalls) || 0,
    hits_allowed: Number(s.hits) || 0,
    earned_runs: Number(s.earnedRuns) || 0,
    pitches_thrown: Number(s.numberOfPitches) || 0,
    batters_faced: Number(s.battersFaced) || 0,
  };
}

/**
 * Returns a KV-cached, cleaned game log for a player — refetched only
 * if the cache is missing or older than 3 hours. Sorted oldest-to-
 * newest so the frontend can slice "last N games" from the end.
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

  const games = splits
    .map(cleanGame)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const result = { player_id: playerId, games, fetched_at: new Date().toISOString() };

  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), {
    expirationTtl: 6 * 60 * 60,
  });

  return result;
}
