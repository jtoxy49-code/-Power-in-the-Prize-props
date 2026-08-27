const MLB_STATS_BASE = "https://statsapi.mlb.com/api/v1/stats";

/**
 * Fetches season pitching stats for every pitcher, all teams, via the
 * official (if unofficial/undocumented) MLB Stats API.
 */
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
 * Entry point — stores the RAW response plus a shape summary so we can
 * confirm the real field names before building a clean mapping. This
 * endpoint's exact JSON structure isn't officially documented, so we're
 * not guessing at it blind.
 */
export async function refreshSeasonStats(env) {
  const year = new Date().getUTCFullYear();
  const raw = await fetchSeasonPitchingStats(year);

  // Try to find the actual list of per-player stat lines wherever it
  // lives in the response, without assuming the exact nesting.
  const splits = raw?.stats?.[0]?.splits || raw?.stats?.splits || null;

  await env.PROPS_DATA.put(
    "stats:season_raw",
    JSON.stringify({
      top_level_keys: Object.keys(raw || {}),
      stats_array_length: Array.isArray(raw?.stats) ? raw.stats.length : null,
      first_stats_entry_keys: raw?.stats?.[0] ? Object.keys(raw.stats[0]) : null,
      splits_found: Array.isArray(splits),
      splits_count: Array.isArray(splits) ? splits.length : null,
      sample_split: Array.isArray(splits) && splits.length > 0 ? splits[0] : null,
      raw,
      updated_at: new Date().toISOString(),
    })
  );

  console.log("Season stats refresh complete — check /debug/season for shape");
}
