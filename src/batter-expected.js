const SAVANT_BASE = "https://baseballsavant.mlb.com/leaderboard/expected_statistics";

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
 * Fetches league-wide batter expected stats for one pitcher-hand
 * split. NOTE: the `team` filter param is confirmed BROKEN for this
 * endpoint (returns HTML instead of CSV) — always fetch league-wide
 * and filter by team downstream, after merging in team affiliation
 * from the season-stats source (which does have team names).
 */
async function fetchBatterExpectedStats(year, hand) {
  const url = `${SAVANT_BASE}?type=batter&year=${year}&position=&team=&min=1&hand=${hand}&csv=true`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });

  if (!res.ok) {
    throw new Error(`Batter expected stats (hand=${hand}) fetch failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

function cleanRow(raw) {
  return {
    player_id: raw["player_id"] || "",
    name: raw["last_name, first_name"] || "",
    pa: Number(raw["pa"]) || 0,
    bip: Number(raw["bip"]) || 0,
    ba: Number(raw["ba"]) || null,
    est_ba: Number(raw["est_ba"]) || null,
    slg: Number(raw["slg"]) || null,
    est_slg: Number(raw["est_slg"]) || null,
    woba: Number(raw["woba"]) || null,
    est_woba: Number(raw["est_woba"]) || null,
  };
}

/**
 * Entry point — fetches both hand splits and stores them separately.
 */
export async function refreshBatterExpectedStats(env) {
  const year = new Date().getUTCFullYear();

  const [vsLhpRaw, vsRhpRaw] = await Promise.all([
    fetchBatterExpectedStats(year, "L"),
    fetchBatterExpectedStats(year, "R"),
  ]);

  const vs_lhp = vsLhpRaw.map(cleanRow).filter((p) => p.name);
  const vs_rhp = vsRhpRaw.map(cleanRow).filter((p) => p.name);

  await env.PROPS_DATA.put(
    "stats:batters_expected",
    JSON.stringify({ vs_lhp, vs_rhp, updated_at: new Date().toISOString() })
  );

  console.log(`Batter expected stats refresh complete: ${vs_lhp.length} vs LHP, ${vs_rhp.length} vs RHP`);
}
