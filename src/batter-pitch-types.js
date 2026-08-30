const SAVANT_ARSENAL_BASE = "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats";

function parseCSVLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((v) => v.trim());
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] !== undefined ? values[i] : "";
    });
    return row;
  });
}

async function fetchBatterPitchTypeStats(year) {
  const url = `${SAVANT_ARSENAL_BASE}?type=batter&year=${year}&position=&team=&min=1&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`Batter pitch-type stats fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

function cleanRow(raw) {
  return {
    player_id: raw["player_id"] || "",
    name: raw["last_name, first_name"] || "",
    pitch_type: raw["pitch_type"] || "",
    pitch_name: raw["pitch_name"] || "",
    pitches: Number(raw["pitches"]) || 0,
    pa: Number(raw["pa"]) || 0,
    ba: Number(raw["ba"]) || null,
    est_ba: Number(raw["est_ba"]) || null,
    whiff_pct: Number(raw["whiff_percent"]) || null,
    k_pct: Number(raw["k_percent"]) || null,
    hard_hit_pct: Number(raw["hard_hit_percent"]) || null,
  };
}

/**
 * Entry point — stores the full flat list (one row per batter per
 * pitch type). Team-level aggregation happens separately, joining
 * against the season-stats team affiliation we already have.
 */
export async function refreshBatterPitchTypeStats(env) {
  const year = new Date().getUTCFullYear();
  const rawRows = await fetchBatterPitchTypeStats(year);
  const rows = rawRows.map(cleanRow).filter((r) => r.name && r.pitch_type);

  await env.PROPS_DATA.put(
    "stats:batter_pitch_types",
    JSON.stringify({ rows, updated_at: new Date().toISOString() })
  );

  console.log(`Batter pitch-type stats refresh complete: ${rows.length} rows stored`);
}

/**
 * Aggregates one team's batters' pitch-type stats into a single
 * PA-weighted team view per pitch type — e.g. "Nationals hitters
 * vs sliders: .245 BA, 32% Whiff%" — matching the reference site's
 * team-level arsenal breakdown.
 */
export async function getTeamPitchTypeSplits(env, teamName) {
  const [pitchTypeData, mergedBatterData] = await Promise.all([
    env.PROPS_DATA.get("stats:batter_pitch_types", "json"),
    env.PROPS_DATA.get("stats:batters_merged", "json"),
  ]);

  const teamPlayerIds = new Set(
    (mergedBatterData?.by_team?.[teamName] || []).map((b) => b.player_id)
  );

  const teamRows = (pitchTypeData?.rows || []).filter((r) => teamPlayerIds.has(r.player_id));

  const byPitchType = {};
  teamRows.forEach((r) => {
    if (!byPitchType[r.pitch_type]) {
      byPitchType[r.pitch_type] = { pitch_type: r.pitch_type, pitch_name: r.pitch_name, total_pa: 0, weighted_ba: 0, weighted_whiff: 0, weighted_k: 0 };
    }
    const bucket = byPitchType[r.pitch_type];
    bucket.total_pa += r.pa;
    bucket.weighted_ba += (r.ba || 0) * r.pa;
    bucket.weighted_whiff += (r.whiff_pct || 0) * r.pa;
    bucket.weighted_k += (r.k_pct || 0) * r.pa;
  });

  return Object.values(byPitchType)
    .map((b) => ({
      pitch_type: b.pitch_type,
      pitch_name: b.pitch_name,
      pa: b.total_pa,
      ba: b.total_pa > 0 ? +(b.weighted_ba / b.total_pa).toFixed(3) : null,
      whiff_pct: b.total_pa > 0 ? +(b.weighted_whiff / b.total_pa).toFixed(1) : null,
      k_pct: b.total_pa > 0 ? +(b.weighted_k / b.total_pa).toFixed(1) : null,
    }))
    .sort((a, b) => b.pa - a.pa);
}
