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

export async function fetchPitchArsenal(year) {
  const url = `${SAVANT_ARSENAL_BASE}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Baseball Savant pitch-arsenal-stats fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

/**
 * Confirmed field mapping (verified against real 2026 data):
 * one row per pitcher per pitch type.
 */
// A blank cell is a stat Savant did not report (null); "0" is a real zero
// and stays 0.
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
 * Entry point — called from the twice-daily cron trigger. Stores the
 * full flat list (one row per pitcher per pitch type); grouping by
 * player happens in merge.js.
 */
export async function refreshArsenalStats(env) {
  const year = new Date().getUTCFullYear();
  const rawRows = await fetchPitchArsenal(year);
  const rows = rawRows.map(cleanRow).filter((r) => r.name && r.pitch_type);

  await env.PROPS_DATA.put(
    "stats:arsenal",
    JSON.stringify({
      rows,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Arsenal stats refresh complete: ${rows.length} pitch-type rows stored`);
}
