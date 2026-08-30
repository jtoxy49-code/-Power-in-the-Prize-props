const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1/stats";

export async function fetchSeasonBattingStats(year) {
  const url = `${MLB_STATS_BASE}?stats=season&group=hitting&season=${year}&sportId=1&playerPool=All&limit=2000`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`MLB Stats API hitting fetch failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Entry point — stores raw shape summary first, same discipline as
 * every other new source. Expect this to mostly match the pitching
 * shape we already confirmed, just with different stat fields.
 */
export async function refreshBatterSeasonStatsRaw(env) {
  const year = new Date().getUTCFullYear();
  const raw = await fetchSeasonBattingStats(year);
  const splits = raw?.stats?.[0]?.splits || [];

  await env.PROPS_DATA.put(
    "stats:batters_season_shape",
    JSON.stringify({
      splits_count: splits.length,
      sample_split: splits[0] || null,
      updated_at: new Date().toISOString(),
    }),
    { expirationTtl: 3600 }
  );

  console.log(`Batter season shape check complete: ${splits.length} splits found`);
}
