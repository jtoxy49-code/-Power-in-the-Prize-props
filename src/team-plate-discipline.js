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
 * Fetches raw pitch-by-pitch data for every batter on a team, over a
 * bounded recent window (NOT full season — see module-level note in
 * getCachedTeamSplits). team= filter confirmed working on this
 * endpoint via live testing (unlike the leaderboard's broken filter).
 */
async function fetchTeamBatterPitches(teamAbbrev, startDate, endDate, pitcherHand) {
  const params = new URLSearchParams({
    all: "true",
    hfGT: "R|",
    hfSea: "2026|",
    player_type: "batter",
    team: teamAbbrev,
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
  if (pitcherHand) params.set("pitcher_throws", pitcherHand);
  const url = `${STATCAST_SEARCH_BASE}?${params.toString()}`;

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`Team batter pitch search failed: ${res.status}`);
  }

  const text = await res.text();
  return parseCSV(text);
}

// Statcast zone convention: 1-9 = inside the strike zone (3x3 grid),
// 11-14 = the four "shadow" quadrants just outside it.
const IN_ZONE = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

const SWING_DESCRIPTIONS = new Set([
  "foul",
  "foul_tip",
  "hit_into_play",
  "swinging_strike",
  "swinging_strike_blocked",
  "foul_bunt",
  "missed_bunt",
]);
const WHIFF_DESCRIPTIONS = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt"]);
const CONTACT_DESCRIPTIONS = new Set(["foul", "foul_tip", "hit_into_play", "foul_bunt"]);

/**
 * Aggregates raw pitches into per-pitch-type Plate Discipline and
 * Batted Ball tables, matching the reference site's structure.
 */
function aggregateByPitchType(pitches) {
  const buckets = {};

  pitches.forEach((p) => {
    const type = p.pitch_type;
    if (!type) return;
    if (!buckets[type]) {
      buckets[type] = {
        pitch_type: type,
        pitch_name: p.pitch_name || type,
        total: 0,
        in_zone: 0,
        out_zone: 0,
        swings: 0,
        o_swings: 0,
        z_swings: 0,
        contacts: 0,
        o_contacts: 0,
        z_contacts: 0,
        whiffs: 0,
        balls_in_play: 0,
        line_drives: 0,
        ground_balls: 0,
        fly_balls: 0,
        popups: 0,
        home_runs: 0,
      };
    }
    const b = buckets[type];
    const inZone = IN_ZONE.has(p.zone);
    const isSwing = SWING_DESCRIPTIONS.has(p.description);
    const isWhiff = WHIFF_DESCRIPTIONS.has(p.description);
    const isContact = CONTACT_DESCRIPTIONS.has(p.description);

    b.total += 1;
    if (inZone) b.in_zone += 1;
    else b.out_zone += 1;

    if (isSwing) {
      b.swings += 1;
      if (inZone) b.z_swings += 1;
      else b.o_swings += 1;
    }
    if (isContact) {
      b.contacts += 1;
      if (inZone) b.z_contacts += 1;
      else b.o_contacts += 1;
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
 * Aggregates raw pitches per-batter (overall, across all pitch
 * types) — the Whiff%/Chase% numbers the batter-by-batter table
 * needs, as opposed to the per-pitch-type breakdown above.
 */
function aggregateByBatter(pitches) {
  const buckets = {};

  pitches.forEach((p) => {
    const id = p.batter;
    if (!id) return;
    if (!buckets[id]) {
      buckets[id] = {
        batter_id: id,
        name: p.player_name || "",
        total: 0,
        out_zone: 0,
        o_swings: 0,
        swings: 0,
        whiffs: 0,
      };
    }
    const b = buckets[id];
    const inZone = IN_ZONE.has(p.zone);
    const isSwing = SWING_DESCRIPTIONS.has(p.description);
    const isWhiff = WHIFF_DESCRIPTIONS.has(p.description);

    b.total += 1;
    if (!inZone) b.out_zone += 1;
    if (isSwing) {
      b.swings += 1;
      if (!inZone) b.o_swings += 1;
    }
    if (isWhiff) b.whiffs += 1;
  });

  const pct = (num, den) => (den > 0 ? +(100 * num / den).toFixed(1) : null);

  return Object.values(buckets).map((b) => ({
    batter_id: b.batter_id,
    name: b.name,
    pitches_seen: b.total,
    chase_pct: pct(b.o_swings, b.out_zone), // O-Swing% — chasing pitches outside the zone
    whiff_pct: pct(b.whiffs, b.swings),
  }));
}

/**
 * Entry point — cached per team since the underlying fetch (a whole
 * team's pitch-level data over 60 days) is heavy enough not to want
 * to repeat on every page view.
 *
 * SCOPING NOTE: uses a 60-day rolling window, not full season, to
 * keep the fetch/parse size manageable. This means these numbers
 * are a "recent form" snapshot, not season-long totals like the
 * reference site shows.
 */
export async function getCachedTeamSplits(env, teamAbbrev, pitcherHand) {
  const cacheKey = pitcherHand ? `team-splits:${teamAbbrev}:${pitcherHand}` : `team-splits:${teamAbbrev}`;
  const cached = await env.PROPS_DATA.get(cacheKey, "json");
  if (cached && cached.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    if (ageMs < 12 * 60 * 60 * 1000) return cached;
  }

  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const pitches = await fetchTeamBatterPitches(teamAbbrev, startDate, endDate, pitcherHand);
  const pitchTypes = aggregateByPitchType(pitches);
  const batters = aggregateByBatter(pitches);

  const result = {
    team: teamAbbrev,
    pitcher_hand_filter: pitcherHand || null,
    window: "last_60_days",
    pitch_types: pitchTypes,
    batters,
    total_pitches_sampled: pitches.length,
    fetched_at: new Date().toISOString(),
  };
  await env.PROPS_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: 24 * 60 * 60 });
  return result;
}
