const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1/stats";

export async function fetchSeasonPitchingStats(year) {
  const url = `${MLB_STATS_BASE}?stats=season&group=pitching&season=${year}&sportId=1&playerPool=All&limit=2000`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`MLB Stats API fetch failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Confirmed field mapping (verified against real 2026 data):
 *   whip, era        -> provided directly
 *   strikeOuts / battersFaced -> K%
 *   baseOnBalls / battersFaced -> BB%
 *
 * Note: FIP is NOT provided by this API (or any public MLB API) —
 * it's a computed sabermetric stat requiring a league-average
 * constant that isn't published anywhere authoritative. Skipped
 * here rather than guessed at.
 */
function cleanSplit(split) {
  const s = split.stat || {};
  const battersFaced = Number(s.battersFaced) || 0;
  const strikeOuts = Number(s.strikeOuts) || 0;
  const baseOnBalls = Number(s.baseOnBalls) || 0;

  return {
    player_id: split.player?.id != null ? String(split.player.id) : null,
    name: split.player?.fullName ?? "",
    team: split.team?.name ?? "",
    era: s.era ? Number(s.era) : null,
    whip: s.whip ? Number(s.whip) : null,
    innings_pitched: s.inningsPitched ?? null,
    batters_faced: battersFaced,
    strikeouts: strikeOuts,
    walks: baseOnBalls,
    k_pct: battersFaced > 0 ? +(100 * strikeOuts / battersFaced).toFixed(1) : null,
    bb_pct: battersFaced > 0 ? +(100 * baseOnBalls / battersFaced).toFixed(1) : null,
  };
}

/**
 * Entry point — called from the twice-daily cron trigger.
 */
export async function refreshSeasonStats(env) {
  const year = new Date().getUTCFullYear();
  const raw = await fetchSeasonPitchingStats(year);
  const splits = raw?.stats?.[0]?.splits || [];

  const pitchers = splits.map(cleanSplit).filter((p) => p.name);

  await env.PROPS_DATA.put(
    "stats:season",
    JSON.stringify({
      pitchers,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Season stats refresh complete: ${pitchers.length} pitcher rows stored`);
}
