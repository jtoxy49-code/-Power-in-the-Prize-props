import { statNum } from "./gamelog.js";

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

// A blank cell is a stat Savant did not report (null); "0" is a real zero
// (a .000 average, a 0% whiff rate) and stays 0.
export function cleanRow(raw) {
  return {
    player_id: raw["player_id"] || "",
    name: raw["last_name, first_name"] || "",
    pitch_type: raw["pitch_type"] || "",
    pitch_name: raw["pitch_name"] || "",
    usage_pct: statNum(raw["pitch_usage"]),
    pitches: statNum(raw["pitches"]) ?? 0,
    pa: statNum(raw["pa"]) ?? 0,
    ba: statNum(raw["ba"]),
    est_ba: statNum(raw["est_ba"]),
    slg: statNum(raw["slg"]),
    est_slg: statNum(raw["est_slg"]),
    woba: statNum(raw["woba"]),
    est_woba: statNum(raw["est_woba"]),
    whiff_pct: statNum(raw["whiff_percent"]),
    k_pct: statNum(raw["k_percent"]),
    put_away_pct: statNum(raw["put_away"]),
    hard_hit_pct: statNum(raw["hard_hit_percent"]),
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

  // PA-weighted per metric. A hitter with no value for a metric is left out of
  // that metric's average (and its weight), never counted as a zero.
  const METRICS = ["ba", "est_ba", "woba", "est_woba", "whiff_pct", "k_pct", "hard_hit_pct"];
  const byPitchType = {};
  teamRows.forEach((r) => {
    if (!byPitchType[r.pitch_type]) {
      byPitchType[r.pitch_type] = { pitch_type: r.pitch_type, pitch_name: r.pitch_name, total_pa: 0, sum: {}, weight: {} };
    }
    const bucket = byPitchType[r.pitch_type];
    bucket.total_pa += r.pa;
    METRICS.forEach((m) => {
      if (r[m] == null || !r.pa) return;
      bucket.sum[m] = (bucket.sum[m] || 0) + r[m] * r.pa;
      bucket.weight[m] = (bucket.weight[m] || 0) + r.pa;
    });
  });
  const avg = (b, m, digits) => (b.weight[m] > 0 ? +(b.sum[m] / b.weight[m]).toFixed(digits) : null);

  return Object.values(byPitchType)
    .map((b) => ({
      pitch_type: b.pitch_type,
      pitch_name: b.pitch_name,
      pa: b.total_pa,
      ba: avg(b, "ba", 3),
      est_ba: avg(b, "est_ba", 3),
      woba: avg(b, "woba", 3),
      est_woba: avg(b, "est_woba", 3),
      whiff_pct: avg(b, "whiff_pct", 1),
      k_pct: avg(b, "k_pct", 1),
      hard_hit_pct: avg(b, "hard_hit_pct", 1),
      bb_pct: null, // NOT available at pitch-type granularity — walks aren't attributable to a single pitch type in this data source. Left null rather than approximated.
    }))
    .sort((a, b) => b.pa - a.pa);
}

/**
 * Per-hitter pitch-type rows for the requested MLB player ids, read straight
 * from the stored leaderboard (no fetch), plus an MLB benchmark per pitch type
 * computed from every hitter's row: xBA, BA and K% weighted by PA, Whiff%
 * weighted by pitches seen (swings are not in this data). Missing values are
 * left out of each average, never counted as zero.
 */
export async function getBatterPitchTypes(env, ids) {
  const data = await env.PROPS_DATA.get("stats:batter_pitch_types", "json");
  const rows = data?.rows || [];
  const want = new Set(ids.map(String));
  const batters = {};
  const league = {};
  rows.forEach((r) => {
    const id = String(r.player_id);
    if (want.has(id)) (batters[id] ||= []).push(r);
    const b = (league[r.pitch_type] ||= { pitch_type: r.pitch_type, pitch_name: r.pitch_name, pa: 0, pitches: 0, sum: {}, weight: {} });
    b.pa += r.pa || 0;
    b.pitches += r.pitches || 0;
    [["est_ba", r.pa], ["ba", r.pa], ["k_pct", r.pa], ["whiff_pct", r.pitches]].forEach(([m, w]) => {
      if (r[m] == null || !w) return;
      b.sum[m] = (b.sum[m] || 0) + r[m] * w;
      b.weight[m] = (b.weight[m] || 0) + w;
    });
  });
  const avg = (b, m, digits) => (b.weight[m] > 0 ? +(b.sum[m] / b.weight[m]).toFixed(digits) : null);
  return {
    batters,
    league: Object.fromEntries(Object.values(league).map((b) => [b.pitch_type, {
      pitch_type: b.pitch_type, pitch_name: b.pitch_name, pa: b.pa, pitches: b.pitches,
      est_ba: avg(b, "est_ba", 3), ba: avg(b, "ba", 3), k_pct: avg(b, "k_pct", 1), whiff_pct: avg(b, "whiff_pct", 1),
    }])),
    updated_at: data?.updated_at || null,
  };
}


