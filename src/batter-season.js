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
 * Confirmed field mapping (verified against real 2026 data).
 * player.id comes through as a NUMBER — cast to String immediately,
 * same fix as the pitching version needed.
 */
function cleanSplit(split) {
  const s = split.stat || {};
  const pa = Number(s.plateAppearances) || 0;
  const k = Number(s.strikeOuts) || 0;
  const bb = Number(s.baseOnBalls) || 0;

  return {
    player_id: split.player?.id != null ? String(split.player.id) : null,
    name: split.player?.fullName ?? "",
    team: split.team?.name ?? "",
    avg: s.avg ? Number(s.avg) : null,
    obp: s.obp ? Number(s.obp) : null,
    slg: s.slg ? Number(s.slg) : null,
    ops: s.ops ? Number(s.ops) : null,
    pa,
    ab: Number(s.atBats) || 0,
    hits: Number(s.hits) || 0,
    doubles: Number(s.doubles) || 0,
    triples: Number(s.triples) || 0,
    home_runs: Number(s.homeRuns) || 0,
    rbi: Number(s.rbi) || 0,
    k_pct: pa > 0 ? +(100 * k / pa).toFixed(1) : null,
    bb_pct: pa > 0 ? +(100 * bb / pa).toFixed(1) : null,
  };
}

export async function refreshBatterSeasonStats(env) {
  const year = new Date().getUTCFullYear();
  const raw = await fetchSeasonBattingStats(year);
  const splits = raw?.stats?.[0]?.splits || [];

  const batters = splits.map(cleanSplit).filter((b) => b.name);

  await env.PROPS_DATA.put(
    "stats:batters_season",
    JSON.stringify({ batters, updated_at: new Date().toISOString() })
  );

  console.log(`Batter season stats refresh complete: ${batters.length} batters stored`);
}
