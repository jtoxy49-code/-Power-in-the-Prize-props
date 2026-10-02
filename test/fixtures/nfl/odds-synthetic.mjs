// A synthetic odds feed for the tests, shaped exactly like the provider's rows
// and behaving the way the 2026-10-02 probe showed the real feed behaves:
//   - DraftKings: one two-sided line per player and market, flagged main.
//   - FanDuel: an over-only ladder plus one two-sided line, posted for a few
//     games only; for yardage the main flag often sits on a ladder rung.
//   - a game in progress arrives flagged is_live, some of it is_active false.
//   - markets outside the V1 allowlist are mixed in.
//   - a few names are spelled the way a book spells them, not the roster.
// Players, teams and games are real (from the nflverse fixture). The prices
// are made up and deterministic. No provider data is stored in the repository;
// the real capture is a local-only file (see nfl-odds-capture.test.mjs).

const NICK = { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LA: "Rams", LAC: "Chargers", LV: "Raiders", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SEA: "Seahawks", SF: "49ers", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" };
const CITY = { ARI: "Arizona", ATL: "Atlanta", BAL: "Baltimore", BUF: "Buffalo", CAR: "Carolina", CHI: "Chicago", CIN: "Cincinnati", CLE: "Cleveland", DAL: "Dallas", DEN: "Denver", DET: "Detroit", GB: "Green Bay", HOU: "Houston", IND: "Indianapolis", JAX: "Jacksonville", KC: "Kansas City", LA: "Los Angeles", LAC: "Los Angeles", LV: "Las Vegas", MIA: "Miami", MIN: "Minnesota", NE: "New England", NO: "New Orleans", NYG: "New York", NYJ: "New York", PHI: "Philadelphia", PIT: "Pittsburgh", SEA: "Seattle", SF: "San Francisco", TB: "Tampa Bay", TEN: "Tennessee", WAS: "Washington" };
// what the feed calls a club: two provider codes seen on NFL rows, and one mixed name spelling
const FEED_ABBR = { LA: "LAR", LV: "LVR" };
const FEED_NAME = { ARI: "ARI Cardinals" };
// names as a sportsbook spells them
const FEED_PLAYER = { "Kenny Gainwell": "Kenneth Gainwell", "Cam Skattebo": "Cameron Skattebo" };

export const CAPTURED_AT = "2026-10-02T03:06:02.549Z";
export const LIVE_GAME = "2026_04_PIT_CLE";
export const FANDUEL_GAMES = ["2026_04_IND_WAS", "2026_04_TEN_BAL", "2026_04_NE_BUF"];

const half = (v) => Math.max(0.5, Math.round(v) - 0.5);
const PRICES = [[-113, -111], [-112, -112], [-115, -109], [-110, -114], [100, -127], [-105, -119]];
const LADDER = { player_passing_yards: [124.5, 149.5, 174.5, 199.5, 224.5, 249.5, 274.5, 299.5, 324.5, 349.5], player_rushing_yards: [9.5, 19.5, 29.5, 39.5, 49.5, 59.5, 69.5, 79.5, 99.5, 124.5], player_receiving_yards: [14.5, 19.5, 24.5, 29.5, 39.5, 49.5, 59.5, 69.5, 79.5, 89.5, 99.5, 109.5, 124.5], player_receptions: [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5] };
const ladderPrice = (rung, main) => { const d = rung - main; const p = Math.round(Math.abs(d) * 9 + 20) * 5; return d < 0 ? -(100 + p) : 100 + p; };

/**
 * @param {object} derived  from deriveAll(): games, rosters, usage, rosterWeek, asOfWeek
 * @returns {object[]} rows ordered as the provider orders them: game, then book, then market
 */
export function syntheticOddsRows(derived) {
  const usage = new Map(derived.usage.filter((u) => u.sample_window === "season").map((u) => [u.player_id, u]));
  const roster = derived.rosters.filter((r) => r.week === derived.rosterWeek && r.status === "ACT");
  const byTeam = (team, pos) => roster.filter((r) => r.team_id === team && r.position === pos && usage.has(r.player_id));
  const top = (team, pos, key, n) => byTeam(team, pos).sort((a, b) => (usage.get(b.player_id)[key] ?? 0) - (usage.get(a.player_id)[key] ?? 0)).slice(0, n);
  const games = derived.games.filter((g) => g.week === derived.asOfWeek).sort((a, b) => a.kickoff_utc.localeCompare(b.kickoff_utc) || a.game_id.localeCompare(b.game_id));
  const rows = [];
  let n = 0;
  const side = (id) => ({ id: `${CITY[id]}_${NICK[id]}`.toLowerCase().replace(/ /g, "_"), name: `${CITY[id]} ${NICK[id]}`, abbreviation: FEED_ABBR[id] || id });

  for (const g of games) {
    const live = g.game_id === LIVE_GAME;
    const eventId = `nfl_${[NICK[g.home_team_id], NICK[g.away_team_id]].map((x) => x.toLowerCase()).sort().join("_")}_${g.kickoff_utc.slice(0, 10)}_b1`;
    const base = {
      event_id: eventId, sport: "football", league: "nfl",
      home_team: FEED_NAME[g.home_team_id] || `${CITY[g.home_team_id]} ${NICK[g.home_team_id]}`, away_team: FEED_NAME[g.away_team_id] || `${CITY[g.away_team_id]} ${NICK[g.away_team_id]}`,
      home: side(g.home_team_id), away: side(g.away_team_id), event_start_time: g.kickoff_utc.slice(0, 16) + "Z",
      is_live: live, is_active: true, is_stale_pregame_price: false, is_player_prop: true, is_impossible_scoreline: false, timestamp: "2026-10-02T03:05:59.555Z",
    };
    // the players a book posts: the starting QB, two backs, three receivers, one tight end per team
    const posted = [];
    for (const team of [g.away_team_id, g.home_team_id]) {
      const qbId = team === g.home_team_id ? g.home_qb_id : g.away_qb_id;
      const qb = roster.find((r) => r.player_id === qbId && usage.has(qbId)) || top(team, "QB", "attempts_pg", 1)[0];
      if (qb) posted.push([qb, ["player_passing_yards", "player_rushing_yards"]]);
      for (const p of top(team, "RB", "carries_pg", 2)) posted.push([p, ["player_rushing_yards", "player_receptions", "player_receiving_yards"]]);
      for (const p of top(team, "WR", "targets_pg", 3)) posted.push([p, ["player_receiving_yards", "player_receptions"]]);
      for (const p of top(team, "TE", "targets_pg", 1)) posted.push([p, ["player_receiving_yards", "player_receptions"]]);
      // a player whose feed spelling differs from the roster is always posted, so name resolution is exercised
      for (const p of byTeam(team, "RB").filter((r) => FEED_PLAYER[r.display_name] && !posted.some(([x]) => x.player_id === r.player_id))) posted.push([p, ["player_rushing_yards", "player_receptions", "player_receiving_yards"]]);
    }
    const books = live ? ["draftkings", "fanduel"] : FANDUEL_GAMES.includes(g.game_id) ? ["draftkings", "fanduel"] : ["draftkings"];
    for (const book of books) {
      const out = [];
      const add = (player, market, line, selection, price, main, extra = {}) => out.push({ ...base, id: `syn-${++n}`, sportsbook: book, market_type: market, player_name: FEED_PLAYER[player.display_name] || player.display_name, selection, selection_type: selection.toLowerCase(), line, odds_american: price, is_main_line: main, is_alternate_line: !main, stat_category: market.replace("player_", ""), ...extra });
      posted.forEach(([player, markets], pi) => {
        const u = usage.get(player.player_id);
        for (const market of markets) {
          const avg = market === "player_passing_yards" ? u.passing_yards_pg : market === "player_rushing_yards" ? u.rushing_yards_pg : market === "player_receiving_yards" ? u.receiving_yards_pg : u.receptions_pg;
          let line = half(market === "player_passing_yards" ? Math.max(150, avg) : Math.max(1, avg));
          let [over, under] = PRICES[(pi + market.length) % PRICES.length];
          const known = KNOWN[`${player.display_name}|${market}`]?.[book];
          if (known) [line, over, under] = known.main;
          if (book === "draftkings") {
            add(player, market, line, "Over", over, true, live && pi === 0 ? { is_active: false } : {});
            add(player, market, line, "Under", under, true, live && pi === 0 ? { is_active: false } : {});
          } else {
            // FanDuel: yardage sits one yard off DraftKings on an in-between number; receptions share the number
            const yard = market !== "player_receptions";
            if (!known) { line = yard ? Math.max(1.5, line) - 1 : line; over = -114; under = -114; if (!yard) { over = 104; under = -134; } }
            const rungs = (known?.ladder || LADDER[market]).filter((r) => r !== line);
            // the provider's flag: on the two-sided line for receptions; for yardage, on the nearest rung every other market
            const flagRung = known && "flagged" in known ? known.flagged : yard && pi % 2 === 0 ? rungs.reduce((a, r) => (Math.abs(r - line) < Math.abs(a - line) ? r : a)) : null;
            for (const r of rungs) add(player, market, r, "Over", r === flagRung && known?.flaggedPrice ? known.flaggedPrice : ladderPrice(r, line), r === flagRung);
            add(player, market, line, "Over", over, flagRung == null);
            add(player, market, line, "Under", under, flagRung == null);
          }
        }
        // markets outside the V1 allowlist, as DraftKings posts them
        if (book === "draftkings" && !live) {
          const extra = player.position === "QB" ? ["player_passing_attempts", "player_passing_completions"] : player.position === "RB" ? ["player_rushing_attempts"] : ["player_longest_reception"];
          for (const m of extra) { add(player, m, 20.5 + pi, "Over", -112, true); add(player, m, 20.5 + pi, "Under", -112, true); }
        }
      });
      out.sort((a, b) => a.market_type.localeCompare(b.market_type));
      rows.push(...out);
    }
  }
  return rows;
}

// A few lines fixed to what the real capture showed, so the tests can name them.
const KNOWN = {
  "Terry McLaurin|player_receiving_yards": {
    draftkings: { main: [51.5, -113, -111] },
    fanduel: { main: [50.5, -114, -114], ladder: [14.5, 19.5, 24.5, 29.5, 39.5, 49.5, 59.5, 69.5, 79.5, 89.5, 99.5, 109.5, 124.5], flagged: 49.5, flaggedPrice: -120 },
  },
  "Terry McLaurin|player_receptions": {
    draftkings: { main: [4.5, 116, -148] },
    fanduel: { main: [4.5, 120, -160], ladder: [2.5, 3.5, 5.5, 6.5, 7.5, 8.5], flagged: null },
  },
};
