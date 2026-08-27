const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

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

/**
 * Confirmed shape (verified against real 2026 schedule data):
 *   game.teams.away/home.team.name, .probablePitcher.fullName
 *   game.lineups.homePlayers / awayPlayers — empty arrays until
 *   lineups are officially posted (~1-2 hrs before first pitch).
 */
function cleanGame(g) {
  return {
    game_pk: g.gamePk,
    status: g.status?.detailedState || "",
    game_time: g.gameDate,
    venue: g.venue?.name || "",
    away_team: g.teams?.away?.team?.name || "",
    home_team: g.teams?.home?.team?.name || "",
    away_probable_pitcher: g.teams?.away?.probablePitcher?.fullName || null,
    home_probable_pitcher: g.teams?.home?.probablePitcher?.fullName || null,
    away_lineup_confirmed: (g.lineups?.awayPlayers?.length || 0) > 0,
    home_lineup_confirmed: (g.lineups?.homePlayers?.length || 0) > 0,
    away_lineup: (g.lineups?.awayPlayers || []).map((p) => ({
      id: p.id,
      name: p.fullName,
    })),
    home_lineup: (g.lineups?.homePlayers || []).map((p) => ({
      id: p.id,
      name: p.fullName,
    })),
  };
}

/**
 * Entry point — fetches and cleans today's games. Cached briefly in
 * KV (10 min) since lineups can post/confirm at any point during
 * the day, and this is cheap enough to refetch often without
 * needing its own dedicated cron.
 */
export async function getTodaysLineups(env) {
  const date = new Date().toISOString().slice(0, 10);
  const cacheKey = `lineups:${date}`;

  const cached = await env.PROPS_DATA.get(cacheKey, "json");
  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 10 * 60 * 1000) {
      return cached;
    }
  }

  const raw = await fetchLineupsForDate(date);
  const games = (raw?.dates?.[0]?.games || []).map(cleanGame);

  const result = { date, games, fetched_at: new Date().toISOString() };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), {
    expirationTtl: 24 * 60 * 60,
  });

  return result;
}
