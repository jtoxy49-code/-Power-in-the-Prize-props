const SAVANT_BASE = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";

/**
 * Parses a single CSV line into an array of fields, honoring quotes
 * (so a quoted field containing a comma — e.g. "Last, First" — stays
 * one field instead of splitting in two).
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
 * Parses a full CSV blob into an array of row objects. Both the
 * header row and every data row go through the same quote-aware
 * parser, so they stay aligned no matter how many fields contain
 * embedded commas.
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
 * Fetches the pitcher expected-stats leaderboard for a given season.
 * min=1 (rather than the default "qualified" threshold) so we capture
 * every pitcher who's appeared, not just qualified starters.
 */
export async function fetchExpectedStats(year) {
  const url = `${SAVANT_BASE}?type=pitcher&year=${year}&position=&team=&min=1&csv=true`;

  const res = await fetch(url, {
    headers: {
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
 * Reshapes raw parsed rows (whose header is literally "last_name,
 * first_name" as one combined column, "Lastname, Firstname" style)
 * into clean objects the frontend can actually use.
 */
function cleanRow(raw) {
  return {
    name: raw["last_name, first_name"] || "",
    player_id: raw["player_id"] || "",
    year: raw["year"] || "",
    pa: Number(raw["pa"]) || 0,
    bip: Number(raw["bip"]) || 0,
    ba: Number(raw["ba"]) || null,
    est_ba: Number(raw["est_ba"]) || null,
    slg: Number(raw["slg"]) || null,
    est_slg: Number(raw["est_slg"]) || null,
    woba: Number(raw["woba"]) || null,
    est_woba: Number(raw["est_woba"]) || null,
    era: Number(raw["era"]) || null,
    xera: Number(raw["xera"]) || null,
  };
}

/**
 * Entry point called from the twice-daily cron trigger.
 * Fetches, cleans, and stores current-season pitcher expected stats.
 *
 * Note: this leaderboard only covers xBA/xSLG/xwOBA/xERA vs actual —
 * it does NOT include Barrel%, HardHit%, K%/BB%, or FIP/WHIP. Those
 * live on separate Savant leaderboards and are a follow-up, not yet
 * pulled here.
 */
export async function refreshStats(env) {
  const year = new Date().getUTCFullYear();
  const rawRows = await fetchExpectedStats(year);
  const pitchers = rawRows.map(cleanRow).filter((p) => p.name);

  await env.PROPS_DATA.put(
    "stats:expected",
    JSON.stringify({
      pitchers,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Stats refresh complete: ${pitchers.length} pitcher rows stored`);
}
