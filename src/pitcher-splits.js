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
 * Fetches one pitcher's own pitches for the full season, optionally
 * filtered to only the plate appearances where a specific-handed
 * batter was up (batter_stands — confirmed param name from the
 * documented search-tool template).
 */
async function fetchPitcherPitches(pitcherId, year, batterStand) {
  const params = new URLSearchParams({
    all: "true",
    hfGT: "R|",
    hfSea: `${year}|`,
    game_date_gt: `${year}-03-01`,
    game_date_lt: new Date().toISOString().slice(0, 10),
    min_pitches: "0",
    min_results: "0",
    group_by: "name",
    sort_col: "pitches",
    player_event_sort: "h_launch_speed",
    sort_order: "desc",
    min_abs: "0",
    type: "details",
  });
  if (batterStand) params.set("batter_stands", batterStand);
  const url = `${STATCAST_SEARCH_BASE}?${params.toString()}&pitchers_lookup[]=${pitcherId}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Pitcher pitch search failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

const IN_ZONE = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const SWING_DESCRIPTIONS = new Set([
  "foul", "foul_tip", "hit_into_play", "swinging_strike",
  "swinging_strike_blocked", "foul_bunt", "missed_bunt",
]);
const WHIFF_DESCRIPTIONS = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
const CONTACT_DESCRIPTIONS = new Set(["foul", "foul_tip", "hit_into_play", "foul_bunt"]);

function aggregateByPitchType(pitches) {
  const buckets = {};

  pitches.forEach((p) => {
    const type = p.pitch_type;
    if (!type) return;
    if (!buckets[type]) {
      buckets[type] = {
        pitch_type: type, pitch_name: p.pitch_name || type,
        total: 0, in_zone: 0, out_zone: 0,
        swings: 0, o_swings: 0, z_swings: 0,
        contacts: 0, o_contacts: 0, z_contacts: 0, whiffs: 0,
        balls_in_play: 0, line_drives: 0, ground_balls: 0, fly_balls: 0, popups: 0, home_runs: 0,
      };
    }
    const b = buckets[type];
    const inZone = IN_ZONE.has(p.zone);
    const isSwing = SWING_DESCRIPTIONS.has(p.description);
    const isWhiff = WHIFF_DESCRIPTIONS.has(p.description);
    const isContact = CONTACT_DESCRIPTIONS.has(p.description);

    b.total += 1;
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

    if (p.description === "hit_into_play" && p.bb_type) {
      b.balls_in_play += 1;
      if (p.bb_type === "line_drive") b.line_drives += 1;
      if (p.bb_type === "ground_ball") b.ground_balls += 1;
      if (p.bb_type === "fly_ball") b.fly_balls += 1;
      if (p.bb_type === "popup") b.popups += 1;
      if (p.events === "home_run") b.home_runs += 1;
    }
  });

  const pct = (num, den) => (den > 0 ? +(100 * num / den).toFixed(1) : null);

  return Object.values(buckets).map((b) => ({
    pitch_type: b.pitch_type,
    pitch_name: b.pitch_name,
    pitches: b.total,
    plate_discipline: {
      o_swing_pct: pct(b.o_swings, b.out_zone),
      z_swing_pct: pct(b.z_swings, b.in_zone),
      swing_pct: pct(b.swings, b.total),
      o_contact_pct: pct(b.o_contacts, b.o_swings),
      z_contact_pct: pct(b.z_contacts, b.z_swings),
      contact_pct: pct(b.contacts, b.swings),
      zone_pct: pct(b.in_zone, b.total),
      swstr_pct: pct(b.whiffs, b.total),
    },
    batted_ball: {
      balls_in_play: b.balls_in_play,
      ld_pct: pct(b.line_drives, b.balls_in_play),
      gb_pct: pct(b.ground_balls, b.balls_in_play),
      fb_pct: pct(b.fly_balls, b.balls_in_play),
      iffb_pct: pct(b.popups, b.balls_in_play),
      hr_per_fb_pct: pct(b.home_runs, b.fly_balls),
    },
  })).sort((a, b) => b.pitches - a.pitches);
}

/**
 * Entry point — cached per (pitcher, batter-hand) combo. Uses the
 * full season (not a rolling window), since a single pitcher's
 * season sample is small enough to fetch directly, unlike the
 * team-wide version.
 */
export async function getCachedPitcherSplits(env, pitcherId, batterStand) {
  const cacheKey = batterStand
    ? `pitcher-splits:${pitcherId}:${batterStand}`
    : `pitcher-splits:${pitcherId}:overall`;

  const cached = await env.PROPS_DATA.get(cacheKey, "json");
  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 12 * 60 * 60 * 1000) return cached;
  }

  const year = new Date().getUTCFullYear();
  const pitches = await fetchPitcherPitches(pitcherId, year, batterStand);
  const pitchTypes = aggregateByPitchType(pitches);

  const result = {
    pitcher_id: pitcherId,
    batter_hand_filter: batterStand || "overall",
    pitch_types: pitchTypes,
    total_pitches_sampled: pitches.length,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 24 * 60 * 60 });
  return result;
}
