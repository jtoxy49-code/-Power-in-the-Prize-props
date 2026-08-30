export async function buildMergedBatterStats(env) {
  const [expectedData, seasonData] = await Promise.all([
    env.PROPS_DATA.get("stats:batters_expected", "json"),
    env.PROPS_DATA.get("stats:batters_season", "json"),
  ]);

  const byId = new Map();

  // Season stats are the authoritative source for name/team, since
  // Savant's expected-stats endpoint has neither.
  (seasonData?.batters || []).forEach((b) => {
    if (!b.player_id) return;
    byId.set(b.player_id, {
      player_id: b.player_id,
      name: b.name,
      team: b.team,
      season: b,
    });
  });

  (expectedData?.vs_lhp || []).forEach((b) => {
    const existing = byId.get(b.player_id);
    if (existing) existing.vs_lhp = b;
    // if there's no season-stats match, we have no team to group by —
    // skip rather than create an orphaned, unteamed entry
  });

  (expectedData?.vs_rhp || []).forEach((b) => {
    const existing = byId.get(b.player_id);
    if (existing) existing.vs_rhp = b;
  });

  const merged = Array.from(byId.values());

  // Group by team for the batter-by-batter table
  const byTeam = {};
  merged.forEach((b) => {
    if (!b.team) return;
    if (!byTeam[b.team]) byTeam[b.team] = [];
    byTeam[b.team].push(b);
  });

  // Sort each team's batters by plate appearances, most active first
  Object.values(byTeam).forEach((list) => list.sort((a, b) => (b.season?.pa || 0) - (a.season?.pa || 0)));

  await env.PROPS_DATA.put(
    "stats:batters_merged",
    JSON.stringify({ by_team: byTeam, updated_at: new Date().toISOString() })
  );

  console.log(`Batter merge complete: ${merged.length} batters across ${Object.keys(byTeam).length} teams`);
  return byTeam;
}
