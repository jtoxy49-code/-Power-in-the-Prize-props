const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

// Regular season plus every postseason round: R regular season, F wild card,
// D division series, L league championship series, W World Series. One call;
// MLB returns each game once with its gameType (verified on 2026 data). Spring
// training and exhibitions are not requested.
export const GAME_TYPES = "R,F,D,L,W";

export async function fetchGameLog(playerId, year) {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${year}&sportId=1&gameType=${GAME_TYPES}`;

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
 * A stat the API did not report stays null (missing), never 0: a missing
 * strikeout count must not read as a real 0-K start. A real 0 stays 0.
 */
export function statNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Confirmed field mapping (verified against real 2026 data):
 * each split has stat{}, team{}, opponent{}, date, isHome, isWin.
 */
function cleanGame(split) {
  const s = split.stat || {};
  return {
    date: split.date,
    game_pk: split.game?.gamePk ?? null,
    game_number: split.game?.gameNumber ?? null,
    // "R" regular season; F, D, L, W are postseason rounds.
    game_type: split.gameType || "R",
    postseason: !!split.gameType && split.gameType !== "R",
    opponent: split.opponent?.name || "",
    is_home: !!split.isHome,
    win: !!split.isWin,
    innings_pitched: s.inningsPitched ?? null,
    outs: statNum(s.outs),
    strikeouts: statNum(s.strikeOuts),
    walks: statNum(s.baseOnBalls),
    hits_allowed: statNum(s.hits),
    earned_runs: statNum(s.earnedRuns),
    pitches_thrown: statNum(s.numberOfPitches),
    batters_faced: statNum(s.battersFaced),
    // MLB marks every game-log appearance with gamesStarted (1 = started,
    // 0 = relief). Passed through so "starts" can mean real starts; null only
    // if a split ever lacks the field (unknown, never guessed).
    started: s.gamesStarted == null ? null : Number(s.gamesStarted) > 0,
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

  // A log cached before the start flag or the postseason was included is
  // treated as stale, so no client ever sees a mix of old and new logs.
  const current = cached?.game_types === GAME_TYPES && cached?.games?.every((g) => "started" in g);
  if (cached && cached.fetched_at && current) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 3 * 60 * 60 * 1000) {
      return cached;
    }
  }

  const raw = await fetchGameLog(playerId, year);
  const splits = raw?.stats?.[0]?.splits || [];

  // Each game once (by MLB gamePk), oldest first; a doubleheader keeps its order.
  const seen = new Set();
  const games = splits
    .map(cleanGame)
    .filter((g) => {
      if (g.game_pk == null) return true;
      if (seen.has(g.game_pk)) return false;
      seen.add(g.game_pk);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (a.game_number ?? 1) - (b.game_number ?? 1));

  const result = { player_id: playerId, game_types: GAME_TYPES, games, fetched_at: new Date().toISOString() };

  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), {
    expirationTtl: 6 * 60 * 60,
  });

  return result;
}
