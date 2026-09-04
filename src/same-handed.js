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
 * Pulls a team's recently completed games, most recent first,
 * capped to a reasonable number so the boxscore-fetching step below
 * doesn't run away.
 */
async function fetchRecentCompletedGames(teamId, limit = 15) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R`;

  const raw = await fetchJson(url);
  const games = (raw?.dates || []).flatMap((d) => d.games);
  const completed = games.filter((g) => g.status?.abstractGameState === "Final");
  completed.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
  return completed.slice(0, limit);
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
    // isTeamHome=true means the opponent (team we're researching) was
    // home, so the starter we're looking at was the VISITING pitcher —
    // i.e. this game was played at the opponent's park.
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

/**
 * Builds (and caches) the full list of starters who've recently
 * faced a given team, regardless of hand — hand-filtering happens
 * cheaply against this cached list, so switching between "same as
 * Snell (L)" and "same as Alcantara (R)" doesn't require refetching.
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

  const games = await fetchRecentCompletedGames(teamId);

  const starterResults = await Promise.all(
    games.map((g) => getOpposingStarterForGame(g, teamId).catch(() => null))
  );
  const starters = starterResults.filter(Boolean);

  const uniqueIds = [...new Set(starters.map((s) => s.pitcher_id))];
  const hands = await Promise.all(
    uniqueIds.map((id) => fetchPitchHand(id).catch(() => null))
  );
  const handById = Object.fromEntries(uniqueIds.map((id, i) => [id, hands[i]]));

  const enriched = starters.map((s) => ({ ...s, hand: handById[s.pitcher_id] || null }));

  const result = { team_name: teamName, starters: enriched, fetched_at: new Date().toISOString() };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 12 * 60 * 60 });
  return result;
}

/**
 * Returns just the starters matching a given hand, most recent first.
 */
export async function getSameHandedStartersVsTeam(env, teamId, teamName, hand, forceRefresh = false) {
  const data = await getRecentStartersVsTeam(env, teamId, teamName, forceRefresh);
  return data.starters.filter((s) => s.hand === hand);
}
