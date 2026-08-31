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

const HIT_EVENTS = new Set(["single", "double", "triple", "home_run"]);
const AB_EXCLUDED_EVENTS = new Set([
  "walk",
  "hit_by_pitch",
  "sac_fly",
  "sac_bunt",
  "catcher_interf",
  "intent_walk",
]);

/**
 * Fetches pitch-level data filtered to one specific batter AND one
 * specific pitcher, across multiple seasons (single-season matchups
 * are often too small a sample to mean anything).
 */
async function fetchMatchupPitches(batterId, pitcherId, years) {
  const params = new URLSearchParams({
    all: "true",
    hfGT: "R|",
    hfSea: years.map((y) => `${y}|`).join(""),
    min_pitches: "0",
    min_results: "0",
    group_by: "name",
    sort_col: "pitches",
    player_event_sort: "h_launch_speed",
    sort_order: "desc",
    min_abs: "0",
    type: "details",
  });
  const url = `${STATCAST_SEARCH_BASE}?${params.toString()}&batters_lookup[]=${batterId}&pitchers_lookup[]=${pitcherId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Batter-vs-pitcher matchup search failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

/**
 * Groups pitches into plate appearances (by game + at-bat number)
 * and computes basic matchup stats from the outcome of each PA.
 */
function summarizeMatchup(pitches) {
  const paMap = new Map();
  pitches.forEach((p) => {
    const key = `${p.game_pk}-${p.at_bat_number}`;
    if (p.events) paMap.set(key, p.events); // only the final pitch of a PA has an event
  });

  const outcomes = Array.from(paMap.values());
  const pa = outcomes.length;
  const abCount = outcomes.filter((e) => !AB_EXCLUDED_EVENTS.has(e)).length;
  const hits = outcomes.filter((e) => HIT_EVENTS.has(e)).length;
  const strikeouts = outcomes.filter((e) => e === "strikeout" || e === "strikeout_double_play").length;
  const walks = outcomes.filter((e) => e === "walk" || e === "intent_walk").length;
  const homeRuns = outcomes.filter((e) => e === "home_run").length;

  return {
    pa,
    ab: abCount,
    hits,
    strikeouts,
    walks,
    home_runs: homeRuns,
    ba: abCount > 0 ? +(hits / abCount).toFixed(3) : null,
    total_pitches: pitches.length,
  };
}

/**
 * Entry point — cached per (batter, pitcher) pair for a day, since
 * this is historical data that only grows slowly (a few PAs per
 * season these two happen to face off).
 */
export async function getCachedMatchup(env, batterId, pitcherId) {
  const cacheKey = `matchup:${batterId}:${pitcherId}`;
  const cached = await env.PROPS_DATA.get(cacheKey, "json");
  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 24 * 60 * 60 * 1000) return cached;
  }

  const currentYear = new Date().getUTCFullYear();
  const years = [currentYear - 2, currentYear - 1, currentYear];

  const pitches = await fetchMatchupPitches(batterId, pitcherId, years);
  const summary = summarizeMatchup(pitches);

  const result = {
    batter_id: batterId,
    pitcher_id: pitcherId,
    years_included: years,
    ...summary,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 7 * 24 * 60 * 60 });
  return result;
}
