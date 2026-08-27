const SAVANT_STATCAST_BASE = "https://baseballsavant.mlb.com/leaderboard/statcast";

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
 * Confirmed field mapping (verified against real 2026 data):
 *   brl_percent      -> Barrel%
 *   ev95percent      -> HardHit% (share of batted balls at 95+ mph)
 *   anglesweetspotpercent -> Sweet-Spot%
 */
function cleanRow(raw) {
  return {
    name: raw["last_name, first_name"] || "",
    player_id: raw["player_id"] || "",
    attempts: Number(raw["attempts"]) || 0,
    avg_exit_velo: Number(raw["avg_hit_speed"]) || null,
    max_exit_velo: Number(raw["max_hit_speed"]) || null,
    sweet_spot_pct: Number(raw["anglesweetspotpercent"]) || null,
    hard_hit_pct: Number(raw["ev95percent"]) || null,
    barrel_pct: Number(raw["brl_percent"]) || null,
    avg_distance: Number(raw["avg_distance"]) || null,
  };
}

/**
 * Entry point — called from the twice-daily cron trigger.
 */
export async function refreshBarrelStats(env) {
  const year = new Date().getUTCFullYear();
  const rawRows = await fetchExitVeloBarrels(year);
  const pitchers = rawRows.map(cleanRow).filter((p) => p.name);

  await env.PROPS_DATA.put(
    "stats:barrels",
    JSON.stringify({
      pitchers,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Barrel stats refresh complete: ${pitchers.length} pitcher rows stored`);
}
