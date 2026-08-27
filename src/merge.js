/**
 * Normalizes a player name for matching across sources that format
 * names differently: "Last, First" (Savant) vs "First Last" (odds,
 * MLB Stats API), plus accents and Jr./Sr./III suffixes that could
 * otherwise cause silent mismatches.
 */
export function normalizeName(raw) {
  if (!raw) return "";
  let name = raw;

  // "Last, First" -> "First Last"
  if (name.includes(",")) {
    const [last, first] = name.split(",").map((s) => s.trim());
    name = `${first} ${last}`;
  }

  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (á -> a, é -> e, etc.)
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Joins expected-stats, barrels, and season-stats by Savant/MLB
 * player_id (the same numbering scheme across both sources), and
 * attaches a normalized_name to each merged record for later
 * matching against odds (which only has a player_name, no ID).
 */
export async function buildMergedStats(env) {
  const [expectedData, barrelsData, seasonData, arsenalData] = await Promise.all([
    env.PROPS_DATA.get("stats:expected", "json"),
    env.PROPS_DATA.get("stats:barrels", "json"),
    env.PROPS_DATA.get("stats:season", "json"),
    env.PROPS_DATA.get("stats:arsenal", "json"),
  ]);

  const byId = new Map();

  const upsert = (id, name, field, value) => {
    if (!id) return;
    const existing = byId.get(id) || {
      player_id: id,
      name,
      normalized_name: normalizeName(name),
    };
    existing[field] = value;
    if (!existing.name && name) {
      existing.name = name;
      existing.normalized_name = normalizeName(name);
    }
    byId.set(id, existing);
  };

  (expectedData?.pitchers || []).forEach((p) => upsert(p.player_id, p.name, "expected", p));
  (barrelsData?.pitchers || []).forEach((p) => upsert(p.player_id, p.name, "barrels", p));
  (seasonData?.pitchers || []).forEach((p) => upsert(p.player_id, p.name, "season", p));

  // Arsenal is many rows per player (one per pitch type) — group them
  // into an array before attaching, rather than a single object.
  const arsenalByPlayer = new Map();
  (arsenalData?.rows || []).forEach((row) => {
    if (!row.player_id) return;
    const list = arsenalByPlayer.get(row.player_id) || [];
    list.push(row);
    arsenalByPlayer.set(row.player_id, list);
  });
  arsenalByPlayer.forEach((pitches, id) => {
    // sort by usage so the most-thrown pitch shows first, matching
    // how the reference site orders the arsenal table
    pitches.sort((a, b) => (b.usage_pct || 0) - (a.usage_pct || 0));
    upsert(id, pitches[0]?.name, "arsenal", pitches);
  });

  const merged = Array.from(byId.values());

  await env.PROPS_DATA.put(
    "stats:merged",
    JSON.stringify({ pitchers: merged, updated_at: new Date().toISOString() })
  );

  console.log(`Merge complete: ${merged.length} pitchers joined`);
  return merged;
}
