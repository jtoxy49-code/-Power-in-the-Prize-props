const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";
const MLB_LIVE_BASE = "https://statsapi.mlb.com/api/v1.1";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return res.json();
}

async function fetchCompletedGamesInRange(teamId, startDate, endDate) {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R`;
  const raw = await fetchJson(url);
  const games = (raw?.dates || []).flatMap((d) => d.games);
  const completed = games.filter((g) => g.status?.abstractGameState === "Final");
  completed.sort((a, b) => new Date(b.gameDate) - new Date(a.gameDate));
  return completed;
}

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

async function fetchPitchHandRaw(playerId) {
  const raw = await fetchJson(`${MLB_STATS_BASE}/people/${playerId}`);
  return raw?.people?.[0]?.pitchHand?.code || null;
}

/**
 * A pitcher's throwing hand never changes, so this is cached in KV
 * permanently (30-day TTL, effectively "forever" for our purposes) —
 * meaning every pitcher we've ever looked up before costs ZERO
 * subrequests on future lookups, which matters a lot given
 * Cloudflare's 50-subrequest-per-invocation limit.
 */
export async function fetchPitchHand(env, playerId) {
  const cacheKey = `pitch-hand:${playerId}`;
  const cached = await env.PROPS_DATA.get(cacheKey);
  if (cached) return cached === "null" ? null : cached;

  const hand = await fetchPitchHandRaw(playerId);
  await env.PROPS_DATA.put(cacheKey, hand || "null", { expirationTtl: 30 * 24 * 60 * 60 });
  return hand;
}

const TARGET_PER_HAND = 10;
const WINDOW_CHUNK_DAYS = 20; // smaller chunks = finer-grained budget control
const SUBREQUEST_BUDGET = 40; // stay well under Cloudflare's 50-per-invocation cap

/**
 * Builds (and caches) a list of starters who've recently faced a
 * given team, expanding the search window further back in time
 * until at least 10 starts of EACH hand are found — but respecting
 * a hard subrequest budget (Cloudflare caps a single Worker
 * invocation at 50 outgoing requests), stopping gracefully with
 * whatever's been found rather than erroring out.
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
  let subrequestCount = 0;
  let windowEnd = new Date();
  let hitBudgetLimit = false;

  while (true) {
    const rCount = allStarters.filter((s) => s.hand === "R").length;
    const lCount = allStarters.filter((s) => s.hand === "L").length;
    if (rCount >= TARGET_PER_HAND && lCount >= TARGET_PER_HAND) break;
    if (subrequestCount >= SUBREQUEST_BUDGET) { hitBudgetLimit = true; break; }

    const windowStart = new Date(windowEnd.getTime() - WINDOW_CHUNK_DAYS * 24 * 60 * 60 * 1000);
    const games = await fetchCompletedGamesInRange(
      teamId,
      windowStart.toISOString().slice(0, 10),
      windowEnd.toISOString().slice(0, 10)
    );
    subrequestCount += 1;
    windowEnd = windowStart;
    if (games.length === 0) continue;

    // Trim this chunk's games if processing all of them would blow
    // the budget (1 subrequest per game for the boxscore fetch).
    const remainingBudget = SUBREQUEST_BUDGET - subrequestCount;
    const gamesToProcess = games.slice(0, Math.max(remainingBudget, 0));
    if (gamesToProcess.length < games.length) hitBudgetLimit = true;
    if (gamesToProcess.length === 0) { hitBudgetLimit = true; break; }

    const starterResults = await Promise.all(
      gamesToProcess.map((g) => getOpposingStarterForGame(g, teamId).catch(() => null))
    );
    subrequestCount += gamesToProcess.length;
    const newStarters = starterResults.filter(Boolean);

    const uniqueIds = [...new Set(newStarters.map((s) => s.pitcher_id))].filter((id) => !handCache.has(id));
    const affordableIds = uniqueIds.slice(0, Math.max(SUBREQUEST_BUDGET - subrequestCount, 0));
    if (affordableIds.length < uniqueIds.length) hitBudgetLimit = true;

    const hands = await Promise.all(affordableIds.map((id) => fetchPitchHand(env, id).catch(() => null)));
    subrequestCount += affordableIds.length;
    affordableIds.forEach((id, i) => handCache.set(id, hands[i]));

    newStarters.forEach((s) => {
      if (handCache.has(s.pitcher_id)) {
        allStarters.push({ ...s, hand: handCache.get(s.pitcher_id) || null });
      }
    });

    if (hitBudgetLimit) break;
  }

  allStarters.sort((a, b) => new Date(b.date) - new Date(a.date));

  const result = {
    team_name: teamName,
    starters: allStarters,
    subrequests_used: subrequestCount,
    hit_budget_limit: hitBudgetLimit,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 12 * 60 * 60 });
  return result;
}

export async function getSameHandedStartersVsTeam(env, teamId, teamName, hand, forceRefresh = false) {
  const data = await getRecentStartersVsTeam(env, teamId, teamName, forceRefresh);
  return data.starters.filter((s) => s.hand === hand).slice(0, TARGET_PER_HAND);
}
