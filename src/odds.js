const SHARPAPI_BASE = "https://api.sharpapi.io/api/v1";

// Regex used once to discover which market_type ids in SharpAPI's
// catalog are MLB pitcher props (as opposed to batter props, which
// share the same "player_*" prefix).
const PITCHER_MARKET_PATTERN =
  /strikeout|earned_run|walks_allowed|hits_allowed|outs_recorded|pitcher/i;

/**
 * Fetches the full market catalog from SharpAPI and filters it down
 * to MLB pitcher-specific market types. Cached in KV so this only
 * needs to run occasionally, not on every 10-minute odds cycle.
 */
async function discoverPitcherMarkets(env) {
  const res = await fetch(`${SHARPAPI_BASE}/markets`, {
    headers: { "X-API-Key": env.SHARPAPI_KEY },
  });

  if (!res.ok) {
    throw new Error(`SharpAPI /markets failed: ${res.status} ${await res.text()}`);
  }

  const { data } = await res.json();

  const pitcherMarkets = data
    .filter((m) => m.sports.includes("baseball") && PITCHER_MARKET_PATTERN.test(m.id))
    .map((m) => m.id);

  await env.PROPS_DATA.put(
    "pitcher_markets",
    JSON.stringify({ markets: pitcherMarkets, updated_at: new Date().toISOString() })
  );

  return pitcherMarkets;
}

/**
 * Reads the cached pitcher market list from KV. If it's missing
 * (first ever run), discovers it fresh instead of failing.
 */
async function getPitcherMarkets(env) {
  const cached = await env.PROPS_DATA.get("pitcher_markets", "json");
  if (cached && cached.markets && cached.markets.length > 0) {
    return cached.markets;
  }
  return discoverPitcherMarkets(env);
}

/**
 * Fetches every page of current MLB pitcher prop odds from SharpAPI,
 * following cursor-based pagination until exhausted.
 */
async function fetchAllPitcherOdds(env, marketList) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 8; // safety cap — well within the free-tier 12 req/min limit

  do {
    const url = new URL(`${SHARPAPI_BASE}/odds`);
    url.searchParams.set("league", "mlb");
    url.searchParams.set("market", marketList.join(","));
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url, {
      headers: { "X-API-Key": env.SHARPAPI_KEY },
    });

    if (!res.ok) {
      throw new Error(`SharpAPI /odds failed: ${res.status} ${await res.text()}`);
    }

    const { data, pagination } = await res.json();
    rows.push(...data);
    pages++;

    cursor = pagination.has_more ? pagination.next_cursor : null;
  } while (cursor && pages < MAX_PAGES);

  return rows;
}

/**
 * Groups flat odds rows into one entry per (player, market, line),
 * with each sportsbook's price attached — the shape the props board
 * UI actually wants to render (one row per prop, odds side by side).
 */
function groupOddsByProp(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!row.player_name) continue; // skip anything that isn't a player prop

    const key = `${row.event_id}|${row.market_type}|${row.player_name}|${row.selection_type}|${row.line}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        event_id: row.event_id,
        market_type: row.market_type,
        player_name: row.player_name,
        home_team: row.home_team,
        away_team: row.away_team,
        home_pitcher: row.home_pitcher,
        away_pitcher: row.away_pitcher,
        selection: row.selection,
        selection_type: row.selection_type,
        line: row.line,
        event_start_time: row.event_start_time,
        books: [],
      });
    }

    grouped.get(key).books.push({
      sportsbook: row.sportsbook,
      odds_american: row.odds_american,
      odds_decimal: row.odds_decimal,
      is_main_line: row.is_main_line,
    });
  }

  return Array.from(grouped.values());
}

/**
 * Entry point called from the 10-minute cron trigger.
 * Fetches, groups, and writes current pitcher prop odds to KV.
 */
export async function refreshOdds(env) {
  const marketList = await getPitcherMarkets(env);
  const rawRows = await fetchAllPitcherOdds(env, marketList);
  const props = groupOddsByProp(rawRows);

  await env.PROPS_DATA.put(
    "odds:latest",
    JSON.stringify({
      props,
      updated_at: new Date().toISOString(),
    })
  );

  console.log(`Odds refresh complete: ${props.length} props stored`);
}
