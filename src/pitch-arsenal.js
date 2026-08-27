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

/**
 * Fetches the pitch-arsenal-stats leaderboard — one row per
 * pitcher per pitch type (Four-Seam, Slider, etc.), not one row
 * per pitcher. min=1 to capture every pitch type thrown, not just
 * qualified volume.
 */
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
 * Entry point — stores RAW parsed rows plus real column names, same
 * as the first pass on every other Savant leaderboard, since this
 * one's exact columns aren't confirmed yet.
 */
export async function refreshArsenalStats(env) {
  const year = new Date().getUTCFullYear();
  const rows = await fetchPitchArsenal(year);

  await env.PROPS_DATA.put(
    "stats:arsenal_raw",
    JSON.stringify({
      row_count: rows.length,
      sample_columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      sample_rows: rows.slice(0, 3), // a few rows, likely different pitch types for the same pitcher
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Arsenal stats refresh complete: ${rows.length} rows stored`);
}
