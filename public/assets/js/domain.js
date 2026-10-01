// Research logic carried over unchanged from the original app. Hit rate is a
// strict comparison against the line (over: value > line, under: value < line),
// samples are the same Season / L10 / L25 / H2H slices, and every average is
// computed exactly as before. Presentation code must not re-derive any of this.
import { slateDate } from "./dates.js";
import { api } from "./api.js";

export const MARKET_LABELS = {
  player_strikeouts: "Strikeouts",
  player_earned_runs: "Earned runs",
  player_earned_runs_allowed: "Earned runs",
  player_walks_allowed: "Walks allowed",
  player_hits_allowed: "Hits allowed",
  player_outs_recorded: "Outs recorded",
};
export const MARKET_SHORT = {
  player_strikeouts: "K",
  player_earned_runs: "ER",
  player_earned_runs_allowed: "ER",
  player_walks_allowed: "BB",
  player_hits_allowed: "H",
  player_outs_recorded: "Outs",
};
export const MARKET_TO_STATKEY = {
  player_strikeouts: "strikeouts",
  player_hits_allowed: "hits_allowed",
  player_earned_runs: "earned_runs",
  player_earned_runs_allowed: "earned_runs",
  player_walks_allowed: "walks",
  player_outs_recorded: "outs",
};
export const STATKEY_TO_MARKET = {
  strikeouts: "player_strikeouts",
  hits_allowed: "player_hits_allowed",
  earned_runs: "player_earned_runs",
  walks: "player_walks_allowed",
  outs: "player_outs_recorded",
};
export const STATS = [
  { key: "strikeouts", label: "Strikeouts", short: "K" },
  { key: "hits_allowed", label: "Hits allowed", short: "H" },
  { key: "earned_runs", label: "Earned runs", short: "ER" },
  { key: "walks", label: "Walks allowed", short: "BB" },
  { key: "outs", label: "Outs recorded", short: "Outs" },
];
export const SAMPLES = [
  { key: "season", label: "Season" },
  { key: "L10", label: "L10" },
  { key: "L25", label: "L25" },
  { key: "H2H", label: "H2H" },
];

export const BOOK_LABELS = { draftkings: "DK", fanduel: "FD", betmgm: "MGM", caesars: "CZR" };
export const BOOK_NAMES = { draftkings: "DraftKings", fanduel: "FanDuel", betmgm: "BetMGM", caesars: "Caesars" };
export const bookLabel = (b) => BOOK_LABELS[b] || String(b).slice(0, 3).toUpperCase();
export const bookName = (b) => BOOK_NAMES[b] || b;

// Display order for markets everywhere: most-bet first.
const MARKET_ORDER = ["player_strikeouts", "player_outs_recorded", "player_hits_allowed", "player_walks_allowed", "player_earned_runs", "player_earned_runs_allowed"];
export const marketRank = (m) => (MARKET_ORDER.indexOf(m) + 1 || 99);

export function marketLabel(marketType) {
  if (MARKET_LABELS[marketType]) return MARKET_LABELS[marketType];
  return String(marketType).replace(/^player_/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export const TEAM_ABBR = {
  "Los Angeles Angels": "LAA", "Arizona Diamondbacks": "AZ", "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC", "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
  "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC", "Los Angeles Dodgers": "LAD",
  "Washington Nationals": "WSH", "New York Mets": "NYM", "Athletics": "ATH", "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD", "Seattle Mariners": "SEA", "San Francisco Giants": "SF", "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB", "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Minnesota Twins": "MIN",
  "Philadelphia Phillies": "PHI", "Atlanta Braves": "ATL", "Chicago White Sox": "CWS", "Miami Marlins": "MIA",
  "New York Yankees": "NYY", "Milwaukee Brewers": "MIL",
};
export const abbr = (name) => (name ? TEAM_ABBR[name] || name.slice(0, 3).toUpperCase() : "");

/**
 * DATA-QUALITY NOTE (odds feed, found 2026-09-28): the same event can arrive
 * with two spellings of one team, e.g. "BOS Red Sox" on DraftKings rows and
 * "Boston Red Sox" on FanDuel rows. Unnormalized, the board would show one
 * game twice. This maps any "<prefix> <Nickname>" spelling ("BOS Red Sox",
 * "LA Dodgers", "NY Mets", "CHI White Sox", "Oakland Athletics") back to the
 * full MLB name used by the schedule: a club nickname is unique among the 30,
 * so it is matched on its own, longest first. A bare abbreviation also maps.
 */
export function normalizeTeam(name) {
  if (!name || TEAM_ABBR[name]) return name;
  const parts = String(name).trim().split(/\s+/);
  const clubs = Object.keys(TEAM_ABBR);
  for (let i = 1; i < parts.length; i++) {
    const nick = parts.slice(i).join(" ");
    const hits = clubs.filter((k) => k === nick || k.endsWith(` ${nick}`));
    if (hits.length === 1) return hits[0];
  }
  return clubs.find((k) => TEAM_ABBR[k] === String(name).trim().toUpperCase()) || name;
}

// DATA-QUALITY NOTE (odds feed, found 2026-09-28, still present): DraftKings
// posts "walks allowed" lines at 6.5 and 7.5 priced near even money, which no
// starter's walk total supports; they are another market mislabeled as walks.
// Lines above these ceilings are not shown anywhere. Only markets with an
// observed mislabel get a ceiling. The Worker quarantines the same rows before
// storing odds (src/odds.js); this is the second guard.
export const LINE_CEILING = { player_walks_allowed: 4.5 };
export const plausibleProp = (p) => !(p.market_type in LINE_CEILING) || Number(p.line) <= LINE_CEILING[p.market_type];

// A pregame price is only shown while the game is pregame. MLB's status decides
// when the pitcher's scheduled game is this event (same teams); otherwise the
// feed's first-pitch time does. In-game prices are never presented as pregame.
const PREGAME = /^(scheduled|pre-game|warmup|delayed start)$/i;
export function pregameProp(p, schedule, now = Date.now()) {
  const g = scheduleFor(schedule, p.player_name)?.game;
  if (g && g.home_team === p.home_team && g.away_team === p.away_team) return !g.status || PREGAME.test(g.status);
  const t = Date.parse(p.event_start_time);
  return isNaN(t) || t > now;
}
export const isPregameStatus = (status) => !status || PREGAME.test(status);

// Roofed MLB parks by MLB's venue name (checked against the 2026 schedule).
export const ROOFS = {
  "Tropicana Field": "dome",
  "Chase Field": "retractable", "Daikin Park": "retractable", "loanDepot park": "retractable",
  "American Family Field": "retractable", "T-Mobile Park": "retractable", "Globe Life Field": "retractable", "Rogers Centre": "retractable",
};

// Static, well-known current MLB league-average reference values, not
// live-fetched, used only for the better/worse comparison. (Unchanged.)
export const LEAGUE_AVG = {
  barrel_pct: 7.6, sweet_spot_pct: 33.3, ba: 0.248, est_ba: 0.243, est_slg: 0.407,
  woba: 0.315, hard_hit_pct: 37.1, k_pct: 22.2, bb_pct: 8.4,
};

export const bestOdds = (prop) => Math.max(...prop.books.map((b) => b.odds_american));
export const isMainLine = (prop) => prop.books.some((b) => b.is_main_line);
export const headshot = (id, w = 120) =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/w_${w},q_100/v1/people/${id}/headshot/67/current`;
// Same MLB image CDN as the headshot. No generic fallback parameter on purpose:
// a player without his own image returns 404 and the page falls back to the
// headshot or to nothing, never to a stock photo of someone else.
export const playerCutout = (id, w = 640) =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/w_${w},q_auto/v1/people/${id}/headshot/silo/current`;
export const playerAction = (id, w = 1600) =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/w_${w},q_auto/v1/people/${id}/action/hero/current`;

export function initialsFor(name) {
  return String(name || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
}

export function avg(arr) {
  const vals = arr.filter((v) => v != null && !isNaN(v));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
// With an even count the median is the mean of the two middle values.
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
export function weightedAvg(items, valueKey, weightKey) {
  let totalWeight = 0, totalValue = 0;
  items.forEach((it) => {
    const v = valueKey(it);
    const w = weightKey(it);
    if (v != null && w) { totalValue += v * w; totalWeight += w; }
  });
  return totalWeight > 0 ? totalValue / totalWeight : null;
}
export function formatInnings(avgOuts) {
  if (avgOuts == null) return null;
  let whole = Math.floor(avgOuts / 3);
  let thirds = Math.round(avgOuts % 3);
  if (thirds === 3) { whole += 1; thirds = 0; }
  return `${whole}.${thirds}`;
}

/**
 * One definition of a "start" for every view (Player Detail and the Board's
 * last-10 strip): MLB's own gamesStarted flag, which the Worker passes through
 * as `started`. Relief outings are left out and returned as `leftOut` so a
 * view can name them. If a log carries no flag at all, nothing is guessed:
 * every appearance is kept and the unit becomes "appearance" for the labels.
 */
// Postseason rounds as MLB codes them in the game log (gameType).
const ROUNDS = { F: { short: "WC", long: "Wild Card" }, D: { short: "DS", long: "Division Series" }, L: { short: "CS", long: "Championship Series" }, W: { short: "WS", long: "World Series" } };
export const postseasonRound = (g) => (g?.postseason ? ROUNDS[g.game_type] || { short: "PS", long: "Postseason" } : null);
export const postseasonCount = (games) => games.filter((g) => g.postseason).length;

export function startsOf(log) {
  const flagged = log.some((g) => "started" in g);
  return flagged
    ? { games: log.filter((g) => g.started === true), unit: "start", leftOut: log.filter((g) => g.started !== true) }
    : { games: log, unit: "appearance", leftOut: [] };
}

export function gamesForSample(games, sample, opponent) {
  if (sample === "season") return games;
  if (sample === "L10") return games.slice(-10);
  if (sample === "L25") return games.slice(-25);
  if (sample === "H2H") return opponent ? games.filter((g) => g.opponent === opponent) : [];
  return games;
}
export const isHit = (value, line, selection) => (selection === "Under" ? value < line : value > line);
/** A start's value for a stat, or null when the source has none (never coerced to 0). */
export const statOf = (g, statKey) => (g[statKey] == null || g[statKey] === "" || isNaN(g[statKey]) ? null : Number(g[statKey]));

// A start with no recorded value is left out of n, the hit count and the
// averages rather than counted as a 0 (which would read as a miss on an Over
// and a hit on an Under). The Worker's gamelog.js keeps a stat the MLB API
// did not report as null (fixed 2026-09-28; it used to coerce it to 0).
export function hitRate(games, statKey, line, selection) {
  const values = games.map((g) => statOf(g, statKey)).filter((v) => v != null);
  const missing = games.length - values.length;
  if (line == null || values.length === 0) {
    return { n: values.length, hits: null, pct: null, mean: avg(values), med: median(values), values, missing };
  }
  const hits = values.filter((v) => isHit(v, line, selection)).length;
  return {
    n: values.length, hits, pct: Math.round((hits / values.length) * 100),
    mean: avg(values), med: median(values), values, missing,
  };
}

/**
 * Name key for matching one pitcher across sources, the same rules the Worker's
 * merge.js uses: accents stripped ("Jesús" vs "Jesus"), case, periods and
 * Jr./Sr. suffixes ignored.
 */
export function nameKey(raw) {
  return String(raw || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.,]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();
}

// Pitcher -> { game_time, opponent, home_team, game } from our own lineups
// data. SharpAPI's home/away pitcher fields are not used for opponent: a
// name-format mismatch once made a pitcher's own team his "opponent".
// Keys are nameKey()s: MLB writes "Jesús Luzardo", the odds feed "Jesus Luzardo".
export function buildScheduleIndex(games) {
  const byPitcher = {};
  games.forEach((g) => {
    if (g.away_probable_pitcher) {
      byPitcher[nameKey(g.away_probable_pitcher)] = { name: g.away_probable_pitcher, game_time: g.game_time, opponent: g.home_team, team: g.away_team, home_team: g.home_team, game: g, side: "away" };
    }
    if (g.home_probable_pitcher) {
      byPitcher[nameKey(g.home_probable_pitcher)] = { name: g.home_probable_pitcher, game_time: g.game_time, opponent: g.away_team, team: g.home_team, home_team: g.home_team, game: g, side: "home" };
    }
  });
  return byPitcher;
}
export const scheduleFor = (schedule, name) => schedule[nameKey(name)] || null;

/**
 * Which side of the event a pitcher is on, when MLB has not named him yet.
 * The feed's home_pitcher / away_pitcher fields use "J Luzardo" (first initial,
 * last name), so compare on that shape instead of the full name.
 */
function sideFromFeed(p) {
  const short = (n) => { const k = nameKey(n).split(" "); return k.length > 1 ? `${k[0][0]} ${k.slice(1).join(" ")}` : k[0]; };
  const me = short(p.player_name);
  if (p.home_pitcher && short(p.home_pitcher) === me) return "home";
  if (p.away_pitcher && short(p.away_pitcher) === me) return "away";
  return null;
}

/** The board's data: odds + ids + four days of lineups, as the original app loaded it. */
export async function loadSlate({ fresh = false } = {}) {
  // Today's baseball day and the next three (Eastern, rolling over at 5 AM; see dates.js).
  const dates = [0, 1, 2, 3].map((n) => slateDate(n));
  const [odds, ids, ...lineups] = await Promise.all([
    api.odds({ fresh }),
    api.pitcherIds().catch(() => ({})),
    // A failed day is remembered as failed, never shown as "no games".
    ...dates.map((d) => api.lineups(d).catch(() => ({ date: d, games: [], failed: true }))),
  ]);
  const games = lineups.flatMap((p) => p.games || []);
  const schedule = buildScheduleIndex(games);
  const now = Date.now();
  const props = (odds.props || []).map((p) => {
    const home = normalizeTeam(p.home_team), away = normalizeTeam(p.away_team);
    return home === p.home_team && away === p.away_team ? p : { ...p, home_team: home, away_team: away };
  }).filter((p) => plausibleProp(p) && pregameProp(p, schedule, now));
  // Headshot / stats ids come from Savant names ("Jesús Luzardo"); resolve the
  // odds feed's spellings to them through the same accent-blind key.
  const idByKey = {};
  Object.entries(ids || {}).forEach(([n, id]) => { idByKey[nameKey(n)] = id; });
  const resolved = { ...(ids || {}) };
  [...props.map((p) => p.player_name), ...games.flatMap((g) => [g.away_probable_pitcher, g.home_probable_pitcher])]
    .filter(Boolean).forEach((n) => { if (!resolved[n] && idByKey[nameKey(n)]) resolved[n] = idByKey[nameKey(n)]; });
  return {
    props,
    updatedAt: odds.updated_at || null,
    ids: resolved,
    lineupsByDate: dates.map((d, i) => ({ date: d, games: lineups[i].games || [], fetchedAt: lineups[i].fetched_at, failed: !!lineups[i].failed })),
    scheduleFailed: lineups.some((l) => l.failed),
    games,
    schedule,
  };
}

/**
 * Board rows: one row per pitcher + market + line, with the Over and Under
 * props side by side. The underlying props and their books are untouched.
 */
export function groupRows(props, schedule) {
  // Side per (event, pitcher) from any of his rows that carry the feed's pitcher fields.
  const feedSide = new Map();
  props.forEach((p) => {
    const k = `${p.event_id}|${nameKey(p.player_name)}`;
    if (!feedSide.get(k)) feedSide.set(k, sideFromFeed(p));
  });
  const map = new Map();
  props.forEach((p) => {
    const key = `${p.event_id}|${p.player_name}|${p.market_type}|${Number(p.line)}`;
    if (!map.has(key)) {
      const sched = scheduleFor(schedule, p.player_name);
      const side = sched?.side || feedSide.get(`${p.event_id}|${nameKey(p.player_name)}`);
      // With neither MLB nor the feed placing him, the side stays unknown rather than guessed.
      const team = sched?.team || (side === "home" ? p.home_team : side === "away" ? p.away_team : null);
      const opponent = sched?.opponent || (side === "home" ? p.away_team : side === "away" ? p.home_team : null);
      map.set(key, {
        key, event_id: p.event_id, player: p.player_name, market: p.market_type, line: Number(p.line),
        home_team: p.home_team, away_team: p.away_team, team, opponent,
        game_time: sched?.game_time || p.event_start_time || null,
        over: null, under: null, main: false,
      });
    }
    const row = map.get(key);
    const side = p.selection === "Under" ? "under" : "over";
    row[side] = p;
    if (isMainLine(p)) row.main = true;
  });
  return [...map.values()];
}

export function sideBest(prop) {
  if (!prop) return null;
  const best = bestOdds(prop);
  const book = prop.books.find((b) => b.odds_american === best);
  return { odds: best, book: book?.sportsbook || null, count: prop.books.length };
}
