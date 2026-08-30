const STATCAST_SEARCH_BASE = "https://baseballsavant.mlb.com/statcast_search/csv";

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
 * Fetches every pitch a given pitcher threw in a date range.
 * pitchers_lookup[] confirmed as the correct filter param via live
 * testing (not officially documented anywhere).
 */
async function fetchPitcherPitches(playerId, startDate, endDate) {
  const params = new URLSearchParams({
    all: "true",
    hfGT: "R|",
    hfSea: "2026|",
    player_type: "pitcher",
    game_date_gt: startDate,
    game_date_lt: endDate,
    min_pitches: "0",
    min_results: "0",
    group_by: "name",
    sort_col: "pitches",
    player_event_sort: "h_launch_speed",
    sort_order: "desc",
    min_abs: "0",
    type: "details",
  });
  const url = `${STATCAST_SEARCH_BASE}?${params.toString()}&pitchers_lookup[]=${playerId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Statcast pitch search failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

const SWINGING_STRIKE_DESCRIPTIONS = new Set(["swinging_strike", "swinging_strike_blocked"]);
const CALLED_STRIKE_DESCRIPTION = "called_strike";

/**
 * Groups raw pitches by game and computes per-game pitch-level
 * metrics: called strikes, swinging strikes, CSW% (called + swinging
 * strikes, as a share of total pitches — a well-known pitching
 * efficiency metric).
 */
function computeGameMetrics(pitches) {
  const byGame = new Map();

  pitches.forEach((p) => {
    const date = p.game_date;
    if (!date) return;
    if (!byGame.has(date)) {
      byGame.set(date, { date, total_pitches: 0, called_strikes: 0, swinging_strikes: 0 });
    }
    const g = byGame.get(date);
    g.total_pitches += 1;
    if (p.description === CALLED_STRIKE_DESCRIPTION) g.called_strikes += 1;
    if (SWINGING_STRIKE_DESCRIPTIONS.has(p.description)) g.swinging_strikes += 1;
  });

  return Array.from(byGame.values())
    .map((g) => ({
      ...g,
      csw_pct:
        g.total_pitches > 0
          ? +(100 * (g.called_strikes + g.swinging_strikes) / g.total_pitches).toFixed(1)
          : null,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

/**
 * Returns a KV-cached set of per-game pitch metrics for one pitcher,
 * covering the last ~45 days (enough to span most of a rotation
 * cycle's worth of starts). Cached 3 hours, same pattern as gamelog.
 */
export async function getCachedPitchMetrics(env, playerId) {
  const cacheKey = `pitch-metrics:${playerId}`;
  const cached = await env.PROPS_DATA.get(cacheKey, "json");
  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 3 * 60 * 60 * 1000) return cached;
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const pitches = await fetchPitcherPitches(playerId, startDate, endDate);
  const games = computeGameMetrics(pitches);

  const result = { player_id: playerId, games, fetched_at: new Date().toISOString() };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 6 * 60 * 60 });
  return result;
}
