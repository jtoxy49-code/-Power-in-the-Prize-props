const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_LIVE_BASE = "https://statsapi.mlb.com/api/v1.1";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return res.json();
}

/**
 * Pulls a team's completed games within a specific date range,
 * most recent first.
 */
async function fetchCompletedGamesInRange(teamId, startDate, endDate) {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R`;
  const raw = await fetchJson(url);
  const games = (raw?.dates || []).flatMap((d) => d.games);
  const completed = games.filter((g) => g.status?.abstractGameState === "Final");
  completed.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
  return completed;
}

/**
 * For one game, finds the starting pitcher for whichever side is
 * NOT the team we're researching, and pulls their line from that
 * specific game.
 */
async function getOpposingStarterForGame(game, teamId) {
  const isTeamHome = game.teams?.home?.team?.id === Number(teamId);
  const opposingSide = isTeamHome ? "away" : "home";

  const feed = await fetchJson(`${MLB_LIVE_BASE}/game/${game.gamePk}/feed/live`);
  const boxTeam = feed?.liveData?.boxscore?.teams?.[opposingSide];
  if (!boxTeam) return null;

  const starterId = boxTeam.pitchers?.[0];
  if (!starterId) return null;

  const record = boxTeam.players?.[`ID${starterId}`];
  const pitching = record?.stats?.pitching;
  if (!pitching) return null;

  return {
    pitcher_id: starterId,
    pitcher_name: record.person?.fullName || "",
    date: game.officialDate,
    venue_relation: isTeamHome ? "at_opponent_park" : "at_starter_home_park",
    innings_pitched: pitching.inningsPitched ?? null,
    strikeouts: Number(pitching.strikeOuts) || 0,
    walks: Number(pitching.baseOnBalls) || 0,
    hits_allowed: Number(pitching.hits) || 0,
    earned_runs: Number(pitching.earnedRuns) || 0,
    pitches_thrown: Number(pitching.numberOfPitches) || 0,
  };
}

async function fetchPitchHand(playerId) {
  const raw = await fetchJson(`${MLB_STATS_BASE}/people/${playerId}`);
  return raw?.people?.[0]?.pitchHand?.code || null;
}

export { fetchPitchHand };

const TARGET_PER_HAND = 10;
const WINDOW_CHUNK_DAYS = 45;
const MAX_GAMES_SEARCHED = 130; // safety cap, ~ one full season's worth

/**
 * Builds (and caches) a list of starters who've recently faced a
 * given team, expanding the search window further back in time
 * until at least 10 starts of EACH hand are found (or the safety
 * cap is hit) — rather than a fixed recent-games window, which can
 * under-represent whichever hand a team happened to face less of
 * lately. The full list (both hands) is cached together, since it
 * serves both "vs RHP" and "vs LHP" lookups without refetching.
 */
export async function getRecentStartersVsTeam(env, teamId, teamName, forceRefresh = false) {
  const cacheKey = `same-handed:${teamId}`;
  if (!forceRefresh) {
    const cached = await env.PROPS_DATA.get(cacheKey, "json");
    if (cached && cached.fetched_at) {
      const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
      if (ageMs < 6 * 60 * 60 * 1000) return cached;
    }
  }

  const handCache = new Map();
  const allStarters = [];
  let totalGamesSearched = 0;
  let windowEnd = new Date();

  while (totalGamesSearched < MAX_GAMES_SEARCHED) {
    const rCount = allStarters.filter((s) => s.hand === "R").length;
    const lCount = allStarters.filter((s) => s.hand === "L").length;
    if (rCount >= TARGET_PER_HAND && lCount >= TARGET_PER_HAND) break;

    const windowStart = new Date(windowEnd.getTime() - WINDOW_CHUNK_DAYS * 24 * 60 * 60 * 1000);
    const games = await fetchCompletedGamesInRange(
      teamId,
      windowStart.toISOString().slice(0, 10),
      windowEnd.toISOString().slice(0, 10)
    );
    windowEnd = windowStart;
    if (games.length === 0) continue; // e.g. an off-season gap — keep stepping back

    totalGamesSearched += games.length;

    const starterResults = await Promise.all(
      games.map((g) => getOpposingStarterForGame(g, teamId).catch(() => null))
    );
    const newStarters = starterResults.filter(Boolean);

    const uniqueIds = [...new Set(newStarters.map((s) => s.pitcher_id))].filter((id) => !handCache.has(id));
    const hands = await Promise.all(uniqueIds.map((id) => fetchPitchHand(id).catch(() => null)));
    uniqueIds.forEach((id, i) => handCache.set(id, hands[i]));

    newStarters.forEach((s) => allStarters.push({ ...s, hand: handCache.get(s.pitcher_id) || null }));
  }

  allStarters.sort((a, b) => new Date(b.date) - new Date(a.date));

  const result = {
    team_name: teamName,
    starters: allStarters,
    games_searched: totalGamesSearched,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 12 * 60 * 60 });
  return result;
}

/**
 * Returns the most recent 10 starters matching a given hand.
 */
export async function getSameHandedStartersVsTeam(env, teamId, teamName, hand, forceRefresh = false) {
  const data = await getRecentStartersVsTeam(env, teamId, teamName, forceRefresh);
  return data.starters.filter((s) => s.hand === hand).slice(0, TARGET_PER_HAND);
}
