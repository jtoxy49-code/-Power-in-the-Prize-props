const SAVANT_STATCAST_BASE = "https://baseballsavant.mlb.com/leaderboard/statcast";

/**
 * Parses a single CSV line into an array of fields, honoring quotes
 * (so a quoted field containing a comma stays one field).
 */
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

/**
 * Parses a full CSV blob into an array of row objects. Header and
 * data rows both go through the same quote-aware parser.
 */
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
 * Fetches the pitcher exit-velocity/barrels leaderboard for a given
 * season. min=1 to capture every pitcher who's appeared, not just
 * qualified starters.
 */
export async function fetchExitVeloBarrels(year) {
  const url = `${SAVANT_STATCAST_BASE}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Baseball Savant exit-velo/barrels fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

/**
 * Entry point — stores RAW parsed rows plus the real column names,
 * same as the first pass on expected_stats. We build the clean field
 * mapping only after confirming actual column names via /debug/barrels,
 * since this leaderboard's exact field names aren't publicly documented.
 */
export async function refreshBarrelStats(env) {
  const year = new Date().getUTCFullYear();
  const rows = await fetchExitVeloBarrels(year);

  await env.PROPS_DATA.put(
    "stats:barrels_raw",
    JSON.stringify({
      row_count: rows.length,
      sample_columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      sample_row: rows.length > 0 ? rows[0] : null,
      rows,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Barrel stats refresh complete: ${rows.length} pitcher rows stored`);
}
