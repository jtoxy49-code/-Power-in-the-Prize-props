const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1";

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return res.json();
}

async function fetchPitchHandRaw(playerId) {
  const raw = await fetchJson(`${MLB_STATS_BASE}/people/${playerId}`);
  return raw?.people?.[0]?.pitchHand?.code || null;
}

/**
 * A pitcher's throwing hand never changes, so this is cached in KV
 * permanently (30-day TTL) — every pitcher looked up once costs
 * zero subrequests on all future lookups, for any team.
 */
export async function fetchPitchHand(env, playerId) {
  const cacheKey = `pitch-hand:${playerId}`;
  const cached = await env.PROPS_DATA.get(cacheKey);
  if (cached) return { hand: cached === "null" ? null : cached, costedSubrequest: false };

  const hand = await fetchPitchHandRaw(playerId);
  await env.PROPS_DATA.put(cacheKey, hand || "null", { expirationTtl: 30 * 24 * 60 * 60 });
  return { hand, costedSubrequest: true };
}

/**
 * ONE request covers the whole lookback window — confirmed via live
 * testing that MLB's schedule endpoint retains probable-pitcher info
 * on completed games, not just upcoming ones. This replaces the old
 * design (one boxscore fetch per game), which made reaching 10
 * same-handed starts run straight into Cloudflare's 50-subrequest-
 * per-invocation cap.
 */
async function fetchGamesWithOpposingProbables(teamId, days) {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R&hydrate=probablePitcher,team`;

  const raw = await fetchJson(url);
  const games = (raw?.dates || []).flatMap((d) => d.games).filter((g) => g.status?.abstractGameState === "Final");

  return games.map((g) => {
    const isTeamHome = g.teams?.home?.team?.id === Number(teamId);
    const opposingProbable = isTeamHome ? g.teams?.away?.probablePitcher : g.teams?.home?.probablePitcher;
    return {
      date: g.officialDate,
      venue_relation: isTeamHome ? "at_opponent_park" : "at_starter_home_park",
      opposing_pitcher_id: opposingProbable?.id || null,
      opposing_pitcher_name: opposingProbable?.fullName || null,
    };
  }).filter((g) => g.opposing_pitcher_id);
}

/**
 * Fetches one pitcher's season game log — reused from the same
 * pattern as gamelog.js — and returns just the games where the
 * date matches one of the target dates (when they faced our team).
 */
async function fetchStatsForDates(playerId, year, targetDates) {
  const url = `${MLB_STATS_BASE}/people/${playerId}/stats?stats=gameLog&group=pitching&season=${year}&sportId=1`;
  const raw = await fetchJson(url);
  const splits = raw?.stats?.[0]?.splits || [];
  const targetSet = new Set(targetDates);

  return splits
    .filter((s) => targetSet.has(s.date))
    .map((s) => {
      const stat = s.stat || {};
      return {
        date: s.date,
        innings_pitched: stat.inningsPitched ?? null,
        strikeouts: Number(stat.strikeOuts) || 0,
        walks: Number(stat.baseOnBalls) || 0,
        hits_allowed: Number(stat.hits) || 0,
        earned_runs: Number(stat.earnedRuns) || 0,
        pitches_thrown: Number(stat.numberOfPitches) || 0,
      };
    });
}

const TARGET_PER_HAND = 10;
const SUBREQUEST_BUDGET = 42; // stay well under Cloudflare's 50-per-invocation cap

/**
 * Builds (and caches) a list of starters who've recently faced a
 * given team, expanding until 10 of EACH hand are found or the
 * subrequest budget runs out. Uses probable-pitcher schedule data
 * (1 request, covers the whole season) + per-UNIQUE-pitcher game
 * logs (1 request each) instead of per-game boxscore fetches —
 * far fewer requests for the same coverage, since a team's opposing
 * starters repeat across many of their games.
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

  let subrequestCount = 0;

  // One request, wide window — covers essentially the whole current
  // season in one shot.
  const games = await fetchGamesWithOpposingProbables(teamId, 200);
  subrequestCount += 1;
  const year = new Date().getUTCFullYear();

  // Group by unique pitcher, most recent appearance first, keeping
  // every date they faced this team (their one gamelog fetch covers
  // all of those dates at once).
  const byPitcher = new Map();
  games.forEach((g) => {
    if (!byPitcher.has(g.opposing_pitcher_id)) {
      byPitcher.set(g.opposing_pitcher_id, {
        pitcher_id: g.opposing_pitcher_id,
        pitcher_name: g.opposing_pitcher_name,
        dates: [],
        venue_by_date: {},
      });
    }
    const entry = byPitcher.get(g.opposing_pitcher_id);
    entry.dates.push(g.date);
    entry.venue_by_date[g.date] = g.venue_relation;
  });

  const uniquePitchers = Array.from(byPitcher.values()).sort((a, b) => {
    const aMax = Math.max(...a.dates.map((d) => new Date(d).getTime()));
    const bMax = Math.max(...b.dates.map((d) => new Date(d).getTime()));
    return bMax - aMax;
  });

  const allStarters = [];
  let hitBudgetLimit = false;

  for (const p of uniquePitchers) {
    const rCount = allStarters.filter((s) => s.hand === "R").length;
    const lCount = allStarters.filter((s) => s.hand === "L").length;
    if (rCount >= TARGET_PER_HAND && lCount >= TARGET_PER_HAND) break;
    if (subrequestCount >= SUBREQUEST_BUDGET) { hitBudgetLimit = true; break; }

    const { hand, costedSubrequest } = await fetchPitchHand(env, p.pitcher_id);
    if (costedSubrequest) subrequestCount += 1;

    // Skip pitchers whose hand we already have enough of.
    if (hand === "R" && rCount >= TARGET_PER_HAND) continue;
    if (hand === "L" && lCount >= TARGET_PER_HAND) continue;
    if (!hand) continue;

    if (subrequestCount >= SUBREQUEST_BUDGET) { hitBudgetLimit = true; break; }
    const statsForDates = await fetchStatsForDates(p.pitcher_id, year, p.dates).catch(() => []);
    subrequestCount += 1;

    statsForDates.forEach((s) => {
      allStarters.push({
        pitcher_id: p.pitcher_id,
        pitcher_name: p.pitcher_name,
        date: s.date,
        venue_relation: p.venue_by_date[s.date] || null,
        innings_pitched: s.innings_pitched,
        strikeouts: s.strikeouts,
        walks: s.walks,
        hits_allowed: s.hits_allowed,
        earned_runs: s.earned_runs,
        pitches_thrown: s.pitches_thrown,
        hand,
      });
    });
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
