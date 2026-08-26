const SAVANT_BASE = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";

/**
 * Minimal CSV parser — handles quoted fields and commas inside quotes.
 * Baseball Savant's leaderboard CSV export is simple enough not to need
 * a full RFC 4180 library for this.
 */
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
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

    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] !== undefined ? values[i].trim() : "";
    });
    return row;
  });
}

/**
 * Fetches the pitcher expected-stats leaderboard for a given season.
 * min=1 (rather than the default "qualified" threshold) so we capture
 * every pitcher who's appeared, not just qualified starters.
 */
export async function fetchExpectedStats(year) {
  const url = `${SAVANT_BASE}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;

  const res = await fetch(url, {
    headers: {
      // Savant serves different content to obvious bot user agents on some endpoints
      "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)",
    },
  });

  if (!res.ok) {
    throw new Error(`Baseball Savant expected_statistics fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

/**
 * Entry point called from the twice-daily cron trigger.
 * Fetches and stores RAW parsed rows for now — column names get
 * verified via /debug/stats before we build the real field mapping
 * (Barrel%, xBA, etc.) into the site's data shape.
 */
export async function refreshStats(env) {
  const year = new Date().getUTCFullYear();
  const rows = await fetchExpectedStats(year);

  await env.PROPS_DATA.put(
    "stats:expected_raw",
    JSON.stringify({
      row_count: rows.length,
      sample_columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Stats refresh complete: ${rows.length} pitcher rows stored`);
}
