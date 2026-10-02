// NFL ODDS: the pure rules. No network, no storage, no clock of their own.
//
// Observed in the provider's live feed on 2026-10-02:
//   - DraftKings sends one two-sided line per player and market.
//   - FanDuel sends an over-only ladder of 6 to 13 lines plus ONE two-sided
//     line, and for yardage its `is_main_line` flag sat on a ladder rung in 6
//     of 16 cases. The provider's flag is therefore never used to pick a line.
//   - The two books often post different numbers for the same player.
import { PROP_BY_MARKET, PROPS, marketId } from "./props.js";
import { normalizeTeam } from "./teams.js";
import { resolvePlayer } from "./players.js";

/** Freshness thresholds in minutes. Configurable through the Worker's vars. */
export const FRESHNESS = { fresh_minutes: 15, stale_minutes: 30 };

/** American odds to the bookmaker's implied probability (vig included). */
export function impliedProbability(american) {
  const o = Number(american);
  if (!Number.isFinite(o) || o === 0) return null;
  return o < 0 ? -o / (-o + 100) : 100 / (o + 100);
}

const median = (values) => { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * THE MAIN-LINE RULE.
 *
 * Input: one sportsbook's lines for one player and prop, each with the price
 * it posts for Over and for Under (either may be missing).
 *
 *   1. Candidates are the lines that have BOTH an Over and an Under price.
 *      An over-only ladder rung can never be a candidate.
 *   2. For each candidate, with p_over and p_under the implied probabilities
 *      of its two prices:   balance = | p_over - p_under |
 *   3. The main line is the candidate with the smallest balance: the number
 *      the book prices closest to even on both sides.
 *   4. Ties, in order: the smaller hold (p_over + p_under - 1); then the line
 *      nearest the median of the candidate lines; then the lower line.
 *
 * With no candidate there is no main line (null) and the book is left out of
 * the main market for that prop.
 */
export function selectMainLine(lines) {
  const candidates = [];
  for (const l of lines) {
    const po = impliedProbability(l.over), pu = impliedProbability(l.under);
    if (po == null || pu == null || !Number.isFinite(Number(l.line))) continue;
    candidates.push({ line: Number(l.line), over: Number(l.over), under: Number(l.under), over_implied: po, under_implied: pu, balance: Math.abs(po - pu), hold: po + pu - 1 });
  }
  if (!candidates.length) return null;
  const mid = median(candidates.map((c) => c.line));
  candidates.sort((a, b) => a.balance - b.balance || a.hold - b.hold || Math.abs(a.line - mid) - Math.abs(b.line - mid) || a.line - b.line);
  const m = candidates[0];
  const r4 = (v) => Number(v.toFixed(4));
  return { line: m.line, over: m.over, under: m.under, over_implied: r4(m.over_implied), under_implied: r4(m.under_implied), hold: r4(m.hold), two_sided_lines: candidates.length };
}

/**
 * How old a sportsbook's prices are.
 *   fresh  age <= fresh_minutes
 *   aging  fresh_minutes < age <= stale_minutes
 *   stale  age > stale_minutes, or the fetch time is unknown
 */
export function freshness(fetchedAt, now, cfg = FRESHNESS) {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return { age_minutes: null, status: "stale" };
  const age = Math.max(0, (now - t) / 60000);
  return { age_minutes: Math.round(age * 10) / 10, status: age <= cfg.fresh_minutes ? "fresh" : age <= cfg.stale_minutes ? "aging" : "stale" };
}

/**
 * Best Over and best Under for one market.
 *   - Prices are compared ONLY between books posting the SAME number. DK 51.5
 *     and FD 50.5 are two lines; they are never merged into one.
 *   - A stale book is never a candidate for "best", so a stale price can never
 *     beat a current one. It is still listed, with its age, as stale.
 *   - An aging book may be best; its age travels with the price.
 * @param {object} market  { books: [{ sportsbook, fetched_at, main }] }
 */
export function bestPrices(market, now, cfg = FRESHNESS) {
  const byLine = new Map();
  for (const b of market.books || []) {
    if (!b.main) continue;
    const f = freshness(b.fetched_at, now, cfg);
    const entry = { sportsbook: b.sportsbook, line: b.main.line, over: b.main.over, under: b.main.under, fetched_at: b.fetched_at, ...f };
    if (!byLine.has(b.main.line)) byLine.set(b.main.line, []);
    byLine.get(b.main.line).push(entry);
  }
  const lines = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, books]) => {
    const live = books.filter((b) => b.status !== "stale");
    const best = (side) => {
      if (!live.length) return null;
      const top = live.reduce((a, b) => (b[side] > a[side] ? b : a));
      return { sportsbook: top.sportsbook, price: top[side], age_minutes: top.age_minutes, status: top.status };
    };
    return { line, books, best_over: best("over"), best_under: best("under"), compared_books: live.length, stale_books: books.filter((b) => b.status === "stale").map((b) => b.sportsbook) };
  });
  return { lines, lines_differ: lines.length > 1 };
}

const sideOf = (row) => { const s = String(row.selection_type ?? row.selection ?? "").toLowerCase(); return s === "over" || s === "under" ? s : null; };

/**
 * Raw provider rows to normalized offers.
 *
 * Dropped (counted, not kept): a market that is not on the V1 allowlist; a row
 * flagged is_live; a row with is_active false (suspended or unavailable); a
 * row flagged as a stale pregame price; a side other than Over or Under; a
 * game that has kicked off.
 * Quarantined (kept whole for review, never published): an unknown team, no
 * matching game, an unresolved or ambiguous player, a player whose position
 * the prop does not allow.
 *
 * @param {object[]} rows
 * @param {object} ctx { games: [{game_id, home_team_id, away_team_id, kickoff_utc}], rosters: {team_id: [player]}, now }
 */
export function normalizeOddsRows(rows, ctx) {
  const dropped = { other_market: 0, live: 0, inactive: 0, stale_flag: 0, other_side: 0, started: 0, bad_values: 0, duplicate: 0 };
  const quarantine = [];
  const offers = new Map(); // market_id|book|side|line -> offer (latest timestamp wins)
  const seenIds = new Set();
  const playerCache = new Map();
  const eventToGame = new Map();
  const gamesByTeams = new Map();
  for (const g of ctx.games) gamesByTeams.set([g.home_team_id, g.away_team_id].sort().join("|"), [...(gamesByTeams.get([g.home_team_id, g.away_team_id].sort().join("|")) || []), g]);
  const hold = (reason, row) => quarantine.push({ reason, sportsbook: row.sportsbook, event_id: row.event_id, market_type: row.market_type, player_name: row.player_name, row });

  for (const row of rows) {
    const prop = PROP_BY_MARKET[row.market_type];
    if (!prop) { dropped.other_market++; continue; }
    if (row.is_live === true) { dropped.live++; continue; }
    if (row.is_active === false) { dropped.inactive++; continue; }
    if (row.is_stale_pregame_price === true) { dropped.stale_flag++; continue; }
    if (row.id != null) { if (seenIds.has(row.id)) { dropped.duplicate++; continue; } seenIds.add(row.id); }
    const side = sideOf(row);
    if (!side) { dropped.other_side++; continue; }
    const line = Number(row.line), price = Number(row.odds_american);
    if (row.line == null || !Number.isFinite(line) || !Number.isFinite(price) || price === 0) { dropped.bad_values++; continue; }

    // teams and game: by abbreviation object first, never by the name string alone
    const home = normalizeTeam(row.home) || normalizeTeam(row.home_team), away = normalizeTeam(row.away) || normalizeTeam(row.away_team);
    if (!home || !away) { hold("unknown_team", row); continue; }
    let game = eventToGame.get(row.event_id);
    if (game === undefined) {
      const start = Date.parse(row.event_start_time);
      const list = gamesByTeams.get([home, away].sort().join("|")) || [];
      game = list.find((g) => !Number.isFinite(start) || Math.abs(Date.parse(g.kickoff_utc) - start) <= 36 * 3600_000) || null;
      eventToGame.set(row.event_id, game);
    }
    if (!game) { hold("no_matching_game", row); continue; }
    if (Date.parse(game.kickoff_utc) <= ctx.now) { dropped.started++; continue; }

    // player: a name is resolved once per game and prop
    const ck = `${game.game_id}|${prop.prop_type}|${row.player_name}`;
    let who = playerCache.get(ck);
    if (!who) {
      const tag = (list, team) => (list || []).map((p) => ({ ...p, team_id: team }));
      const pool = [...tag(ctx.rosters[home], home), ...tag(ctx.rosters[away], away)];
      who = resolvePlayer(row.player_name, pool.filter((p) => prop.positions.includes(p.position)));
      if (!who.player_id) {
        const any = resolvePlayer(row.player_name, pool);
        if (any.player_id) who = { player_id: null, reason: "position_not_allowed", matches: 1 };
      } else {
        const p = pool.find((x) => x.player_id === who.player_id);
        who = { ...who, team_id: p.team_id, position: p.position, display_name: p.display_name };
      }
      playerCache.set(ck, who);
    }
    if (!who.player_id) { hold(who.reason, row); continue; }

    const id = marketId(game.game_id, who.player_id, prop.prop_type);
    const key = `${id}|${row.sportsbook}|${side}|${line}`;
    const prev = offers.get(key);
    if (prev) { dropped.duplicate++; if (String(prev.seen_at) >= String(row.timestamp)) continue; }
    offers.set(key, {
      market_id: id, game_id: game.game_id, event_id: row.event_id, player_id: who.player_id, player_name: who.display_name, feed_name: row.player_name,
      team_id: who.team_id, position: who.position, prop_type: prop.prop_type, market_type: row.market_type, exposed: prop.exposed.includes(who.position),
      sportsbook: row.sportsbook, side, line, price, seen_at: row.timestamp ?? null, provider_main: row.is_main_line === true, match_method: who.method,
    });
  }
  return { offers: [...offers.values()], quarantine, dropped, events: eventToGame };
}

/**
 * Offers for ONE sportsbook and game into that book's market entries:
 * its main line (by value) and its ladder (every other line).
 * A main line outside the prop's sanity bounds is withheld and reported.
 */
export function buildBookMarkets(offers, fetchedAt) {
  const groups = new Map();
  for (const o of offers) {
    const k = `${o.market_id}|${o.sportsbook}`;
    if (!groups.has(k)) groups.set(k, { head: o, lines: new Map() });
    const g = groups.get(k);
    if (!g.lines.has(o.line)) g.lines.set(o.line, { line: o.line, over: null, under: null, provider_main: false });
    const l = g.lines.get(o.line);
    l[o.side] = o.price;
    if (o.provider_main) l.provider_main = true;
    if (!g.seen_at || String(o.seen_at) > String(g.seen_at)) g.seen_at = o.seen_at;
  }
  const entries = [], implausible = [];
  for (const g of groups.values()) {
    const lines = [...g.lines.values()].sort((a, b) => a.line - b.line);
    let main = selectMainLine(lines);
    const prop = PROPS[g.head.prop_type];
    if (main && (main.line < prop.line_floor || main.line > prop.line_ceiling)) { implausible.push({ market_id: g.head.market_id, sportsbook: g.head.sportsbook, line: main.line }); main = null; }
    entries.push({
      market_id: g.head.market_id, game_id: g.head.game_id, player_id: g.head.player_id, player_name: g.head.player_name, team_id: g.head.team_id, position: g.head.position,
      prop_type: g.head.prop_type, market_type: g.head.market_type, exposed: g.head.exposed,
      book: {
        sportsbook: g.head.sportsbook, fetched_at: fetchedAt, seen_at: g.seen_at ?? null, main,
        // every other line this book posts: FanDuel's over-only ladder in practice
        ladder: lines.filter((l) => !main || l.line !== main.line).map((l) => ({ line: l.line, over: l.over, under: l.under })),
        // kept for diagnosis only; never used to choose the main line
        provider_flagged_line: lines.find((l) => l.provider_main)?.line ?? null,
      },
    });
  }
  return { entries, implausible };
}

/** Per-book entries merged into one market per player and prop, books side by side. */
export function mergeMarkets(entries) {
  const markets = new Map();
  for (const e of entries) {
    if (!markets.has(e.market_id)) { const { book, ...head } = e; markets.set(e.market_id, { ...head, books: [] }); }
    markets.get(e.market_id).books.push(e.book);
  }
  for (const m of markets.values()) m.books.sort((a, b) => a.sportsbook.localeCompare(b.sportsbook));
  return [...markets.values()].sort((a, b) => a.game_id.localeCompare(b.game_id) || a.player_name.localeCompare(b.player_name) || a.prop_type.localeCompare(b.prop_type));
}
