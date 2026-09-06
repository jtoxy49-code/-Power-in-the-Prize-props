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
  "walk", "hit_by_pitch", "sac_fly", "sac_bunt", "catcher_interf", "intent_walk",
]);
const IN_ZONE = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const SWING_DESCRIPTIONS = new Set([
  "foul", "foul_tip", "hit_into_play", "swinging_strike",
  "swinging_strike_blocked", "foul_bunt", "missed_bunt",
]);
const WHIFF_DESCRIPTIONS = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
const CONTACT_DESCRIPTIONS = new Set(["foul", "foul_tip", "hit_into_play", "foul_bunt"]);

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
    if (p.events) paMap.set(key, p.events);
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
 * Breaks the matchup down by pitch type into three tables matching
 * the reference site: Pitch Mix (usage/BA/xBA/Hard%/Whiff%/K%/BB%),
 * Plate Discipline, and Batted Ball.
 *
 * HONESTY NOTE: xBA is computed rigorously (expected hits ÷ AB,
 * where each batted ball contributes its own hit probability and
 * strikeouts correctly contribute 0). xwOBA and RV/100 are
 * best-effort approximations — true wOBA weighting requires
 * season-specific linear weight constants we don't have a verified
 * source for (same limitation as WRC+), and RV/100's sign
 * convention (delta_run_exp) hasn't been independently verified
 * against a known-correct value. Treat those two as directional,
 * not precise.
 */
function aggregateByPitchType(pitches) {
  // First pass: find each PA's outcome event and which pitch ended it.
  const paEndingPitchType = new Map(); // "game_pk-at_bat_number" -> pitch_type
  const paOutcome = new Map();
  pitches.forEach((p) => {
    const key = `${p.game_pk}-${p.at_bat_number}`;
    if (p.events) {
      paOutcome.set(key, p.events);
      paEndingPitchType.set(key, p.pitch_type);
    }
  });

  const buckets = {};
  const totalPitches = pitches.length;

  const ensureBucket = (type, name) => {
    if (!buckets[type]) {
      buckets[type] = {
        pitch_type: type, pitch_name: name || type,
        pitches: 0, pa_keys: new Set(),
        in_zone: 0, out_zone: 0, swings: 0, o_swings: 0, z_swings: 0,
        contacts: 0, o_contacts: 0, z_contacts: 0, whiffs: 0,
        balls_in_play: 0, line_drives: 0, ground_balls: 0, fly_balls: 0, popups: 0, home_runs_bb: 0,
        hard_hit: 0,
        xh_sum: 0, xwoba_sum: 0, xwoba_n: 0,
        run_exp_sum: 0,
      };
    }
    return buckets[type];
  };

  pitches.forEach((p) => {
    const type = p.pitch_type;
    if (!type) return;
    const b = ensureBucket(type, p.pitch_name);
    const inZone = IN_ZONE.has(p.zone);
    const isSwing = SWING_DESCRIPTIONS.has(p.description);
    const isWhiff = WHIFF_DESCRIPTIONS.has(p.description);
    const isContact = CONTACT_DESCRIPTIONS.has(p.description);

    b.pitches += 1;
    if (inZone) b.in_zone += 1; else b.out_zone += 1;
    if (isSwing) {
      b.swings += 1;
      if (inZone) b.z_swings += 1; else b.o_swings += 1;
    }
    if (isContact) {
      b.contacts += 1;
      if (inZone) b.z_contacts += 1; else b.o_contacts += 1;
    }
    if (isWhiff) b.whiffs += 1;

    const runExp = Number(p.delta_run_exp);
    if (!isNaN(runExp)) b.run_exp_sum += runExp;

    if (p.description === "hit_into_play" && p.bb_type) {
      b.balls_in_play += 1;
      if (p.bb_type === "line_drive") b.line_drives += 1;
      if (p.bb_type === "ground_ball") b.ground_balls += 1;
      if (p.bb_type === "fly_ball") b.fly_balls += 1;
      if (p.bb_type === "popup") b.popups += 1;
      if (p.events === "home_run") b.home_runs_bb += 1;

      const launchSpeed = Number(p.launch_speed);
      if (!isNaN(launchSpeed) && launchSpeed >= 95) b.hard_hit += 1;

      const estBa = Number(p.estimated_ba_using_speedangle);
      if (!isNaN(estBa)) b.xh_sum += estBa;

      const estWoba = Number(p.estimated_woba_using_speedangle);
      if (!isNaN(estWoba)) { b.xwoba_sum += estWoba; b.xwoba_n += 1; }
    }

    // Track which PAs involved this pitch type at all (for usage-based PA count)
    const key = `${p.game_pk}-${p.at_bat_number}`;
    b.pa_keys.add(key);
  });

  const pct = (num, den) => (den > 0 ? +(100 * num / den).toFixed(1) : null);

  return Object.values(buckets).map((b) => {
    // PA/AB/hits/K/BB specifically for PAs that ENDED on this pitch type
    const endingKeys = Array.from(paEndingPitchType.entries())
      .filter(([, type]) => type === b.pitch_type)
      .map(([key]) => key);
    const outcomes = endingKeys.map((k) => paOutcome.get(k));
    const pa = outcomes.length;
    const ab = outcomes.filter((e) => !AB_EXCLUDED_EVENTS.has(e)).length;
    const hits = outcomes.filter((e) => HIT_EVENTS.has(e)).length;
    const k = outcomes.filter((e) => e === "strikeout" || e === "strikeout_double_play").length;
    const bb = outcomes.filter((e) => e === "walk" || e === "intent_walk").length;

    const ba = ab > 0 ? hits / ab : null;
    // xBA: expected hits (sum of each batted ball's own hit probability,
    // strikeouts correctly contribute 0) ÷ AB.
    const xba = ab > 0 ? b.xh_sum / ab : null;
    const xwoba = b.xwoba_n > 0 ? b.xwoba_sum / b.xwoba_n : null; // approximate — batted-ball-only average

    return {
      pitch_type: b.pitch_type,
      pitch_name: b.pitch_name,
      usage_pct: pct(b.pitches, totalPitches),
      pa,
      ba: ba != null ? +ba.toFixed(3) : null,
      xba: xba != null ? +xba.toFixed(3) : null,
      xwoba: xwoba != null ? +xwoba.toFixed(3) : null, // approximate, see module note
      hard_hit_pct: pct(b.hard_hit, b.balls_in_play),
      whiff_pct: pct(b.whiffs, b.swings),
      k_pct: pct(k, pa),
      bb_pct: pct(bb, pa),
      rv_per_100: b.pitches > 0 ? +((-b.run_exp_sum / b.pitches) * 100).toFixed(1) : null, // approximate sign convention, see module note
      plate_discipline: {
        pa,
        o_swing_pct: pct(b.o_swings, b.out_zone),
        z_swing_pct: pct(b.z_swings, b.in_zone),
        swing_pct: pct(b.swings, b.pitches),
        o_contact_pct: pct(b.o_contacts, b.o_swings),
        z_contact_pct: pct(b.z_contacts, b.z_swings),
        contact_pct: pct(b.contacts, b.swings),
        zone_pct: pct(b.in_zone, b.pitches),
        swstr_pct: pct(b.whiffs, b.pitches),
      },
      batted_ball: {
        pa,
        balls_in_play: b.balls_in_play,
        ld_pct: pct(b.line_drives, b.balls_in_play),
        gb_pct: pct(b.ground_balls, b.balls_in_play),
        fb_pct: pct(b.fly_balls, b.balls_in_play),
        iffb_pct: pct(b.popups, b.balls_in_play),
        hr_per_fb_pct: pct(b.home_runs_bb, b.fly_balls),
      },
    };
  }).sort((a, b) => b.pa - a.pa);
}

/**
 * Entry point — cached per (batter, pitcher) pair for a day, since
 * this is historical data that only grows slowly.
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
  const pitchTypes = aggregateByPitchType(pitches);

  const result = {
    batter_id: batterId,
    pitcher_id: pitcherId,
    years_included: years,
    ...summary,
    pitch_types: pitchTypes,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 7 * 24 * 60 * 60 });
  return result;
}
