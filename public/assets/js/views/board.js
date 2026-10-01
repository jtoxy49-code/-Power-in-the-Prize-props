// TODAY'S BOARD. Every filter the original board had survives (league,
// teams, games, pitchers, propositions, over/under, main lines, odds sort,
// clear all) and every filter now lives in the URL, so the board can be
// shared, refreshed, and returned to exactly as it was left.
import { api } from "../api.js";
import { loadSlate, groupRows, sideBest, abbr, marketLabel, marketRank, MARKET_SHORT, MARKET_TO_STATKEY, bookLabel, bookName, isHit, statOf, startsOf, postseasonRound } from "../domain.js";
import { esc, time, relDay, ago, odds as fmtOdds, oddsText, line as fmtLine } from "../format.js";
import { avatar, pitcherHref, errorState } from "../ui.js";
import { icon } from "../icons.js";

const SORTS = {
  time: (a, b) => new Date(a.game_time || 0) - new Date(b.game_time || 0) || a.event_id.localeCompare(b.event_id) || a.player.localeCompare(b.player) || marketRank(a.market) - marketRank(b.market) || a.line - b.line,
  pitcher: (a, b) => a.player.localeCompare(b.player) || a.line - b.line,
  line: (a, b) => a.line - b.line,
  over: (a, b) => (sideBest(a.over)?.odds ?? -Infinity) - (sideBest(b.over)?.odds ?? -Infinity),
  under: (a, b) => (sideBest(a.under)?.odds ?? -Infinity) - (sideBest(b.under)?.odds ?? -Infinity),
};

function readState(params) {
  const list = (k) => (params.get(k) ? params.get(k).split("|").filter(Boolean) : []);
  return {
    q: params.get("q") || "",
    markets: new Set(list("m")),
    side: ["over", "under"].includes(params.get("side")) ? params.get("side") : "both",
    main: params.get("main") !== "0",
    games: new Set(list("g")),
    teams: new Set(list("t")),
    pitchers: new Set(list("p")),
    sort: SORTS[params.get("sort")] ? params.get("sort") : "time",
    dir: params.get("dir") === "desc" ? "desc" : "asc",
  };
}

function writeState(s, setQuery) {
  setQuery((p) => {
    const set = (k, v) => (v ? p.set(k, v) : p.delete(k));
    p.set("view", "board");
    set("q", s.q);
    set("m", [...s.markets].join("|"));
    set("side", s.side === "both" ? "" : s.side);
    set("main", s.main ? "" : "0");
    set("g", [...s.games].join("|"));
    set("t", [...s.teams].join("|"));
    set("p", [...s.pitchers].join("|"));
    set("sort", s.sort === "time" ? "" : s.sort);
    set("dir", s.dir === "asc" ? "" : s.dir);
  });
}

export function render(root, params, { setQuery }) {
  const state = readState(params);
  let slate = null;
  let alive = true;
  // Back and reload hand the router a saved scroll position, but the board is
  // still a skeleton at that moment; land on it once the rows exist.
  let restoreY = history.state?.scrollY || 0;
  const expanded = new Set();
  const trend = new Map(); // player -> Promise<games[]>

  root.innerHTML = `
    <div class="page board">
      <header class="page-head">
        <div>
          <h1 class="h-page">Pitcher props</h1>
          <p class="lede" id="board-lede" aria-live="polite">Loading the board…</p>
        </div>
        <div class="seg league" role="radiogroup" aria-label="League">
          <button type="button" role="radio" aria-checked="true">MLB</button>
          <button type="button" role="radio" aria-checked="false" aria-disabled="true" disabled title="NFL props are coming soon">NFL<span class="seg-meta">Soon</span></button>
          <button type="button" role="radio" aria-checked="false" aria-disabled="true" disabled title="NBA props are coming soon">NBA<span class="seg-meta">Soon</span></button>
        </div>
      </header>

      <div class="filterbar" id="filterbar">
        <div class="fb-row">
          <label class="search fb-search">
            ${icon("magnifying-glass")}
            <span class="sr-only">Find a pitcher or team</span>
            <input id="f-q" type="search" placeholder="Find a pitcher or team…" autocomplete="off" spellcheck="false" value="${esc(state.q)}">
            <kbd aria-hidden="true">/</kbd>
          </label>
          <button class="btn btn-quiet fb-sheet-btn" id="f-sheet-btn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="fb-controls">${icon("sliders-horizontal")}Filters<span class="badge" id="f-sheet-count" hidden></span></button>
          <div class="fb-controls" id="fb-controls" aria-label="Filters">
            <div class="sheet-head fb-sheet-only"><span class="h-section">Filters</span><button class="icon-btn" type="button" id="f-sheet-close" aria-label="Close filters">${icon("x")}</button></div>
            <div class="fb-markets" id="f-markets" role="group" aria-label="Proposition"></div>
            <div class="seg" id="f-side" role="radiogroup" aria-label="Side">
              ${["both", "over", "under"].map((v) => `<button type="button" role="radio" data-v="${v}" aria-checked="${state.side === v}">${v === "both" ? "Both" : v === "over" ? "Over" : "Under"}</button>`).join("")}
            </div>
            <label class="switch" title="Only lines a book flags as its main line">
              <input id="f-main" type="checkbox" ${state.main ? "checked" : ""}><span class="track"></span>Main lines
            </label>
            <button class="btn btn-quiet fb-more" id="f-more" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="f-pop">${icon("sliders-horizontal")}Games, teams, pitchers<span class="badge" id="f-more-count" hidden></span></button>
            <button class="btn btn-primary fb-sheet-only" type="button" id="f-sheet-done">Show lines</button>
          </div>
        </div>
        <div class="fb-tokens" id="f-tokens"></div>
      </div>
      <div class="popover" id="f-pop" role="dialog" aria-label="Filter games, teams and pitchers" hidden></div>
      <p class="b-key"><span class="b-key-l">Last 10 starts against each line</span><span><i class="k-h"></i>Went over the line</span><span><i class="k-m"></i>Did not</span><span><i class="k-x"></i>No recorded value</span></p>

      <div class="board-body" id="board-body">
        <div class="sk-table" aria-busy="true">${Array.from({ length: 6 }, () => '<span class="skeleton"></span>').join("")}</div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const body = $("#board-body");

  // ---------- data ----------
  const load = async (fresh = false) => {
    try {
      slate = await loadSlate({ fresh });
      if (!alive) return;
      paintMarkets();
      paint();
      if (restoreY && window.scrollY < restoreY) window.scrollTo(0, restoreY);
      restoreY = 0;
    } catch {
      if (!alive) return;
      body.innerHTML = `<div class="b-empty">${errorState("Couldn't load the board.", "The odds request failed. Your filters are kept; try again.", "board-retry")}</div>`;
      $("#board-retry")?.addEventListener("click", () => load(true));
      $("#board-lede").textContent = "Odds unavailable";
    }
  };

  function allRows() {
    return groupRows(slate.props, slate.schedule);
  }

  function filtered() {
    let rows = allRows();
    const q = state.q.trim().toLowerCase();
    if (state.main) rows = rows.filter((r) => r.main);
    if (state.markets.size) rows = rows.filter((r) => state.markets.has(r.market));
    if (state.side === "over") rows = rows.filter((r) => r.over);
    if (state.side === "under") rows = rows.filter((r) => r.under);
    if (state.games.size) rows = rows.filter((r) => state.games.has(`${r.away_team} @ ${r.home_team}`));
    if (state.teams.size) rows = rows.filter((r) => state.teams.has(r.away_team) || state.teams.has(r.home_team));
    if (state.pitchers.size) rows = rows.filter((r) => state.pitchers.has(r.player));
    if (q) rows = rows.filter((r) => `${r.player} ${r.home_team} ${r.away_team} ${abbr(r.home_team)} ${abbr(r.away_team)}`.toLowerCase().includes(q));
    const cmp = SORTS[state.sort];
    rows.sort((a, b) => (state.dir === "desc" ? -cmp(a, b) : cmp(a, b)));
    return rows;
  }

  // ---------- filter bar ----------
  function paintMarkets() {
    const counts = {};
    allRows().filter((r) => !state.main || r.main).forEach((r) => { counts[r.market] = (counts[r.market] || 0) + 1; });
    const markets = Object.keys(counts).sort((a, b) => marketRank(a) - marketRank(b));
    const all = !state.markets.size;
    const mk = $("#f-markets");
    // Repainting the chips must not drop keyboard focus or the tablet line's scroll position.
    const focused = document.activeElement?.closest?.("#f-markets [data-m]")?.dataset.m;
    const left = mk.scrollLeft;
    mk.innerHTML =
      `<button class="tchip" type="button" data-m="" aria-pressed="${all}">All props</button>` +
      markets.map((m) => `<button class="tchip" type="button" data-m="${esc(m)}" aria-pressed="${state.markets.has(m)}">${esc(marketLabel(m))}<span class="count">${counts[m]}</span></button>`).join("");
    mk.scrollLeft = left;
    if (focused != null) mk.querySelector(`[data-m="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    fadeMarkets();
  }

  // On tablet the prop chips hold one line and scroll sideways when they run
  // out of room; a fade marks the edge that has more.
  function fadeMarkets() {
    const mk = $("#f-markets");
    const max = mk.scrollWidth - mk.clientWidth, s = mk.scrollLeft;
    mk.dataset.fade = max <= 1 ? "" : s <= 1 ? "end" : s >= max - 1 ? "start" : "both";
  }

  function paintTokens() {
    const tokens = [
      ...[...state.games].map((v) => ["g", v, `Game: ${abbrGame(v)}`]),
      ...[...state.teams].map((v) => ["t", v, `Team: ${abbr(v)}`]),
      ...[...state.pitchers].map((v) => ["p", v, `Pitcher: ${v}`]),
    ];
    const n = tokens.length;
    const badge = $("#f-more-count");
    badge.hidden = !n; badge.textContent = n;
    const active = n + state.markets.size + (state.side !== "both" ? 1 : 0) + (state.main ? 0 : 1);
    const sb = $("#f-sheet-count");
    sb.hidden = !active; sb.textContent = active;
    const shown = slate ? filtered().length : 0;
    $("#f-sheet-done").textContent = `Show ${shown} ${shown === 1 ? "line" : "lines"}`;
    const anyActive = n || state.q || state.markets.size || state.side !== "both" || !state.main;
    $("#f-tokens").innerHTML = anyActive
      ? tokens.map(([k, v, label]) => `<button class="token" type="button" data-k="${k}" data-v="${esc(v)}" aria-label="Remove ${esc(label)}">${esc(label)}${icon("x")}</button>`).join("") +
        `<button class="btn btn-ghost fb-clear" id="f-clear" type="button">Clear all</button>`
      : "";
  }

  function paintPopover() {
    const rows = allRows();
    const count = (fn) => rows.reduce((m, r) => { fn(r).forEach((k) => m.set(k, (m.get(k) || 0) + 1)); return m; }, new Map());
    const games = count((r) => [`${r.away_team} @ ${r.home_team}`]);
    const teams = count((r) => [r.away_team, r.home_team]);
    const pitchers = count((r) => [r.player]);
    const group = (title, key, map, set, labelFn) => `
      <div class="pop-head">${title}</div>
      ${[...map.keys()].sort().map((v) => `
        <label class="check-row"><input type="checkbox" data-k="${key}" value="${esc(v)}" ${set.has(v) ? "checked" : ""}>${esc(labelFn(v))}<span class="count">${map.get(v)}</span></label>`).join("")}`;
    $("#f-pop").innerHTML =
      group("Games", "g", games, state.games, abbrGame) +
      group("Teams", "t", teams, state.teams, (v) => v) +
      group("Pitchers", "p", pitchers, state.pitchers, (v) => v);
  }

  // ---------- rows ----------
  // Grouped (time order): each game opens on a ruled band, each pitcher is
  // established once, and his props belong to him beneath. Any other sort is
  // a flat list, so every row names its pitcher.
  function venueFor(r) {
    const g = slate.games.find((x) => x.home_team === r.home_team && x.away_team === r.away_team &&
      (!r.game_time || !x.game_time || Math.abs(new Date(x.game_time) - new Date(r.game_time)) < 12 * 3600_000));
    return g?.venue || "";
  }

  function paint() {
    const rows = filtered();
    const total = allRows().length;
    $("#board-lede").textContent = slate.updatedAt
      ? `${rows.length} of ${total} ${total === 1 ? "line" : "lines"}. Odds updated ${ago(slate.updatedAt)}.`
      : `${rows.length} lines`;
    paintTokens();
    root.querySelector(".b-key .k-h").parentElement.lastChild.textContent = state.side === "under" ? "Went under the line" : "Went over the line";
    if (!total) {
      body.innerHTML = `<div class="b-empty"><div class="state"><strong>No pitcher props are posted right now.</strong><span>The odds feed refreshes every 10 minutes. The schedule for the next few days is on the Home page.</span><a class="btn btn-quiet" href="/" data-link>Go to Home</a></div></div>`;
      return;
    }
    if (!rows.length) {
      body.innerHTML = `<div class="b-empty"><div class="state"><strong>No lines match these filters.</strong><span>Remove a filter or clear them all to see the full board.</span><button class="btn btn-quiet" type="button" id="empty-clear">Clear all filters</button></div></div>`;
      $("#empty-clear").addEventListener("click", clearAll);
      return;
    }
    const grouped = state.sort === "time";
    const perGame = new Map();
    rows.forEach((r) => perGame.set(r.event_id, (perGame.get(r.event_id) || 0) + 1));
    let lastGame = null, lastPlayer = null;
    const trs = [];
    rows.forEach((r) => {
      const gk = r.event_id;
      if (grouped && gk !== lastGame) {
        lastGame = gk; lastPlayer = null;
        const venue = venueFor(r);
        const n = perGame.get(gk);
        trs.push(`<tr class="game-head"><th colspan="7" scope="colgroup"><div class="gh">
          <span class="gh-teams">${esc(abbr(r.away_team))}<i>@</i>${esc(abbr(r.home_team))}</span>
          <span class="gh-when">${esc(relDay(r.game_time))} ${esc(time(r.game_time))}</span>
          ${venue ? `<span class="gh-venue">${esc(venue)}</span>` : ""}
          <span class="gh-n">${n} ${n === 1 ? "line" : "lines"}</span>
        </div></th></tr>`);
      }
      if (grouped && r.player !== lastPlayer) trs.push(pitcherHeadHtml(r));
      trs.push(rowHtml(r, grouped));
      lastPlayer = r.player;
      if (expanded.has(r.key)) trs.push(detailRowHtml(r));
    });
    const first = !body.querySelector(".bt");
    const side = state.side === "under" ? "under" : "over";
    body.innerHTML = `
      <div class="board-panel${first ? " reveal" : " refresh"}">
        ${grouped ? '<div class="pl-stick" id="pl-stick" aria-hidden="true" hidden><div class="ps-in"></div></div>' : ""}
        <table class="bt${grouped ? " grouped" : ""}">
          <caption class="sr-only">Pitcher prop lines with best available prices${grouped ? ", grouped by game and pitcher" : ""}. Select a prop to open research.</caption>
          <thead><tr>
            ${th("pitcher", grouped ? "Pitcher and prop" : "Pitcher", "bt-player")}
            <th scope="col" class="bt-mkt">Prop</th>
            ${th("line", "Line", "bt-line")}
            ${th("over", "Over", "bt-px")}
            ${th("under", "Under", "bt-px")}
            <th scope="col" class="bt-trend"><span title="Each block is one of his last 10 starts, oldest first. Solid: went ${side} this line. Hatched: did not. Outlined: no recorded value.">Last 10 starts, ${side}</span></th>
            <th scope="col" class="bt-x"><span class="sr-only">Books</span></th>
          </tr></thead>
          <tbody>${trs.join("")}</tbody>
        </table>
      </div>`;
    observeTrends();
    setupStick();
  }

  // ---------- sticky pitcher ----------
  // Grouped mode establishes each pitcher once. While his prop rows scroll, a
  // compact strip under the column header keeps the game and the pitcher in
  // view; the next pitcher or game band pushes it up and takes over.
  let stick = null, heads = [], stickTop = 0, stripH = 0, stickCur = null, stickRaf = 0;
  function setupStick() {
    stick = body.querySelector("#pl-stick");
    heads = stick ? [...body.querySelectorAll("tr.game-head, tr.pl-head")] : [];
    stickCur = null;
    measureStick();
    updateStick();
  }
  function measureStick() {
    const fb = $("#filterbar");
    const th = body.querySelector(".bt thead th");
    const thH = th && th.offsetParent ? th.offsetHeight : 0;
    stickTop = (parseFloat(getComputedStyle(fb).top) || 0) + fb.offsetHeight + thH;
    const board = root.querySelector(".board");
    stripH = parseFloat(getComputedStyle(board).getPropertyValue("--ps-h")) || 0;
    board.style.setProperty("--stick-top", `${stickTop}px`);
    // Keyboard focus scrolls rows clear of the filter bar, the column header and the strip.
    document.documentElement.style.setProperty("--sticky-offset", `${stickTop + (stick ? stripH : 0)}px`);
  }
  function updateStick() {
    stickRaf = 0;
    if (!stick) return;
    let cur = null, nextTop = null;
    for (const h of heads) {
      const top = h.getBoundingClientRect().top;
      if (top >= stickTop) { nextTop = top; break; }
      cur = h.classList.contains("pl-head") ? h : null;
    }
    // Show the strip only once the real header has gone under the sticky bars.
    if (!cur || cur.getBoundingClientRect().bottom > stickTop + stripH) {
      stick.hidden = true; stickCur = null;
      return;
    }
    if (cur !== stickCur) {
      stickCur = cur;
      const face = cur.querySelector(".plh-face")?.cloneNode(true);
      const inner = stick.firstElementChild;
      inner.innerHTML = `<span class="ps-game">${esc(cur.dataset.game)}</span><span class="ps-who"></span>`;
      const who = inner.lastElementChild;
      if (face) { face.classList.replace("plh-face", "ps-face"); face.style.setProperty("--size", "28px"); who.append(face); }
      who.insertAdjacentHTML("beforeend", `<span class="ps-name">${esc(cur.dataset.player)}</span>${cur.dataset.team ? `<span class="ps-team">${esc(cur.dataset.team)}</span>` : ""}`);
    }
    const y = nextTop == null ? 0 : Math.min(0, nextTop - stickTop - stripH);
    stick.style.setProperty("--ps-y", `${y}px`);
    stick.hidden = false;
  }
  const onStickScroll = () => { if (!stickRaf) stickRaf = requestAnimationFrame(updateStick); };
  const onStickResize = () => { measureStick(); fadeMarkets(); onStickScroll(); };
  window.addEventListener("scroll", onStickScroll, { passive: true });
  window.addEventListener("resize", onStickResize);

  function th(key, label, cls) {
    const active = state.sort === key;
    const sortDir = active ? (state.dir === "asc" ? "ascending" : "descending") : "none";
    return `<th scope="col" class="${cls}" aria-sort="${sortDir}"><button type="button" class="sort" data-sort="${key}">${label}${icon(active ? (state.dir === "asc" ? "caret-down" : "caret-down") : "caret-up-down", active && state.dir === "asc" ? "flip" : "")}</button></th>`;
  }

  function linkBase(r) {
    return { name: r.player, market: r.market, line: r.line, opponent: r.opponent, home_team: r.home_team, game_time: r.game_time, matchup: `${r.away_team} @ ${r.home_team}`, team: r.team };
  }

  // The pitcher, once per game: face, name and side; a link to his research.
  function pitcherHeadHtml(r) {
    const id = slate.ids[r.player];
    const href = pitcherHref({ ...linkBase(r), selection: state.side === "under" ? "Under" : "Over" });
    return `
      <tr class="pl-head" data-player="${esc(r.player)}" data-game="${esc(abbr(r.away_team))} @ ${esc(abbr(r.home_team))}" data-team="${r.team ? esc(abbr(r.team)) : ""}"><th colspan="7" scope="rowgroup">
        <a class="plh" href="${esc(href)}" data-link>
          ${avatar(r.player, id, 48, "plh-face")}
          <span class="plh-name">${esc(r.player)}</span>
          <span class="plh-meta">${r.team ? `${esc(abbr(r.team))} vs ${esc(abbr(r.opponent))}` : `${esc(abbr(r.away_team))} @ ${esc(abbr(r.home_team))}, team unconfirmed`}</span>
        </a>
      </th></tr>`;
  }

  function rowHtml(r, grouped) {
    const o = state.side === "under" ? null : sideBest(r.over);
    const u = state.side === "over" ? null : sideBest(r.under);
    const base = linkBase(r);
    const defaultSide = state.side === "under" || (!r.over && r.under) ? "Under" : "Over";
    const href = pitcherHref({ ...base, selection: defaultSide });
    const id = slate.ids[r.player];
    const priceLink = (best, sel) => best
      ? `<a class="px" href="${esc(pitcherHref({ ...base, selection: sel }))}" data-link aria-label="${esc(sel)} ${esc(fmtLine(r.line))} at ${esc(oddsText(best.odds))}, best of ${best.count} ${best.count === 1 ? "book" : "books"} at ${esc(bookName(best.book))}. Research ${esc(sel.toLowerCase())}" title="Best of ${best.count} ${best.count === 1 ? "book" : "books"}"><span class="px-side">${sel === "Over" ? "O" : "U"}</span><span class="num">${fmtOdds(best.odds)}</span><span class="px-book">${esc(bookName(best.book))}</span></a>`
      : `<span class="px px-none" aria-label="No ${sel.toLowerCase()} price">-</span>`;
    const isOpen = expanded.has(r.key);
    const lead = grouped
      ? `<a class="pl pl-prop" href="${esc(href)}" data-link aria-label="${esc(r.player)}, ${esc(marketLabel(r.market))} ${esc(fmtLine(r.line))}"><span class="pl-mk">${esc(marketLabel(r.market))}</span>${r.main ? "" : '<span class="pl-alt">Alt line</span>'}</a>`
      : `<a class="pl" href="${esc(href)}" data-link>
          ${avatar(r.player, id, 36)}
          <span class="pl-text"><span class="pl-name">${esc(r.player)}</span><span class="pl-meta">${r.team ? `${esc(abbr(r.team))} vs ${esc(abbr(r.opponent))}` : `${esc(abbr(r.away_team))} @ ${esc(abbr(r.home_team))}, team unconfirmed`}<span class="pl-time">, ${esc(relDay(r.game_time))} ${esc(time(r.game_time))}</span></span></span>
        </a>`;
    return `
      <tr class="bt-row" data-key="${esc(r.key)}">
        <td class="bt-player">${lead}</td>
        <td class="bt-mkt txt">${esc(marketLabel(r.market))}</td>
        <td class="bt-line"><span class="ln" aria-label="${esc(marketLabel(r.market))} line ${esc(fmtLine(r.line))}"><b>${esc(fmtLine(r.line))}</b><i>${esc(MARKET_SHORT[r.market] || "")}</i></span></td>
        <td class="bt-px">${state.side === "under" ? '<span class="px px-none" aria-hidden="true"></span>' : priceLink(o, "Over")}</td>
        <td class="bt-px">${state.side === "over" ? '<span class="px px-none" aria-hidden="true"></span>' : priceLink(u, "Under")}</td>
        <td class="bt-trend" data-trend="${esc(r.player)}" data-stat="${esc(MARKET_TO_STATKEY[r.market] || "strikeouts")}" data-line="${r.line}" aria-busy="true"><span class="trend-sk skeleton"></span></td>
        <td class="bt-x"><button class="icon-btn expander" type="button" data-expand="${esc(r.key)}" aria-expanded="${isOpen}" aria-label="${isOpen ? "Hide" : "Show"} every book's price for ${esc(r.player)}, ${esc(marketLabel(r.market))}">${icon("caret-down", isOpen ? "flip" : "")}</button></td>
      </tr>`;
  }

  function detailRowHtml(r) {
    const books = [...new Set([...(r.over?.books || []), ...(r.under?.books || [])].map((b) => b.sportsbook))];
    const price = (prop, book) => {
      const b = prop?.books.find((x) => x.sportsbook === book);
      if (!b) return `<span class="faint">-</span>`;
      const best = prop && b.odds_american === Math.max(...prop.books.map((x) => x.odds_american));
      return `<span class="num ${best ? "best" : ""}">${fmtOdds(b.odds_american)}</span>${best && prop.books.length > 1 ? '<span class="sr-only"> best price</span>' : ""}`;
    };
    const alts = groupRows(slate.props, slate.schedule)
      .filter((x) => x.player === r.player && x.market === r.market && x.key !== r.key)
      .sort((a, b) => a.line - b.line);
    return `
      <tr class="bt-detail"><td colspan="7">
        <div class="books">
          <table class="books-t">
            <caption class="sr-only">${esc(r.player)} ${esc(marketLabel(r.market))} ${esc(fmtLine(r.line))} by sportsbook</caption>
            <thead><tr><th scope="col">Book</th><th scope="col">Over ${esc(fmtLine(r.line))}</th><th scope="col">Under ${esc(fmtLine(r.line))}</th><th scope="col">Main line</th></tr></thead>
            <tbody>${books.map((b) => {
              const main = [r.over, r.under].some((p) => p?.books.find((x) => x.sportsbook === b)?.is_main_line);
              return `<tr><th scope="row">${esc(bookName(b))}</th><td>${price(r.over, b)}</td><td>${price(r.under, b)}</td><td class="faint">${main ? "Yes" : "No"}</td></tr>`;
            }).join("")}</tbody>
          </table>
          ${alts.length ? `<div class="alts"><span class="faint">Other ${esc(marketLabel(r.market).toLowerCase())} lines:</span> ${alts.map((a) => `<span class="alt"><span class="num">${esc(fmtLine(a.line))}</span> O <span class="num">${fmtOdds(sideBest(a.over)?.odds ?? null)}</span> / U <span class="num">${fmtOdds(sideBest(a.under)?.odds ?? null)}</span></span>`).join("")}</div>` : ""}
        </div>
      </td></tr>`;
  }

  // ---------- last-10 trend (lazy, only for rows on screen) ----------
  let io = null;
  function observeTrends() {
    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        io.unobserve(e.target);
        fillTrend(e.target);
      });
    }, { rootMargin: "200px 0px" });
    body.querySelectorAll("[data-trend]").forEach((td) => io.observe(td));
  }
  function gamesFor(player) {
    if (!trend.has(player)) {
      const id = slate.ids[player];
      trend.set(player, id ? api.gamelog(id).then((d) => d.games || []) : Promise.resolve(null));
    }
    return trend.get(player);
  }
  async function fillTrend(td) {
    const games = await gamesFor(td.dataset.trend).catch(() => { trend.delete(td.dataset.trend); return "failed"; });
    if (!alive || !td.isConnected) return;
    td.removeAttribute("aria-busy");
    // A request that failed is retried on the next repaint; it never reads as "no game log".
    if (games === "failed") { td.innerHTML = `<span class="faint trend-na">Couldn't load</span>`; return; }
    if (!games || !games.length) { td.innerHTML = `<span class="faint trend-na">No game log</span>`; return; }
    const stat = td.dataset.stat, lineV = Number(td.dataset.line);
    const sel = state.side === "under" ? "Under" : "Over";
    // Same definition of a start as Player Detail: relief outings never count.
    const { games: starts, unit } = startsOf(games);
    if (!starts.length) { td.innerHTML = `<span class="faint trend-na">No ${unit}s yet</span>`; return; }
    const last = starts.slice(-10);
    // A start with no recorded value is shown as a gap and left out of the count.
    const vals = last.map((g) => statOf(g, stat));
    const known = vals.filter((v) => v != null);
    const hits = known.filter((v) => isHit(v, lineV, sel)).length;
    const cells = last.map((g, i) => {
      const v = vals[i];
      const ps = postseasonRound(g) ? `, ${postseasonRound(g).long}` : "";
      if (v == null) return `<i class="x" title="${esc(g.date)} vs ${esc(g.opponent)}${ps}: no data"></i>`;
      return `<i class="${isHit(v, lineV, sel) ? "h" : "m"}" title="${esc(g.date)} vs ${esc(g.opponent)}${ps}: ${v}"></i>`;
    }).join("");
    td.removeAttribute("aria-busy");
    td.innerHTML = `<span class="trend" aria-label="${sel} ${fmtLine(lineV)} hit in ${hits} of his last ${known.length} ${unit}s with a recorded value"><span class="trend-cells" aria-hidden="true">${cells}</span><span class="trend-n"><b>${hits}</b>/${known.length}</span><span class="trend-side">${sel === "Over" ? "over" : "under"}</span></span>`;
  }

  // ---------- events ----------
  const commit = () => { writeState(state, setQuery); paintMarkets(); paint(); };
  function clearAll() {
    state.q = ""; state.markets.clear(); state.side = "both"; state.main = true;
    state.games.clear(); state.teams.clear(); state.pitchers.clear();
    $("#f-q").value = "";
    root.querySelectorAll("#f-side button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === "both")));
    $("#f-main").checked = true;
    commit();
  }

  let qTimer;
  $("#f-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = e.target.value; if (slate) commit(); }, 120);
  });
  $("#f-markets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const m = b.dataset.m;
    if (!m) state.markets.clear();
    else if (state.markets.has(m)) state.markets.delete(m);
    else state.markets.add(m);
    commit();
  });
  $("#f-side").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    state.side = b.dataset.v;
    root.querySelectorAll("#f-side button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    commit();
  });
  $("#f-side").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const btns = [...root.querySelectorAll("#f-side button")];
    const i = btns.indexOf(document.activeElement);
    const next = btns[(i + (e.key === "ArrowRight" ? 1 : btns.length - 1)) % btns.length];
    next.focus(); next.click();
  });
  $("#f-main").addEventListener("change", (e) => { state.main = e.target.checked; commit(); });

  const pop = $("#f-pop"), more = $("#f-more");
  const closePop = () => { pop.hidden = true; more.setAttribute("aria-expanded", "false"); };
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!pop.hidden) return closePop();
    if (!slate) return;
    paintPopover();
    const r = more.getBoundingClientRect();
    pop.hidden = false;
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    // Open below the button when it fits, otherwise above it (inside the phone sheet).
    pop.style.top = `${r.bottom + 6 + ph < window.innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
    pop.style.left = `${Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12))}px`;
    more.setAttribute("aria-expanded", "true");
    pop.querySelector("input")?.focus();
  });
  pop.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-k]");
    if (!cb) return;
    const set = { g: state.games, t: state.teams, p: state.pitchers }[cb.dataset.k];
    if (cb.checked) set.add(cb.value); else set.delete(cb.value);
    commit();
  });
  const onDocClick = (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== more) closePop(); };
  const onKey = (e) => {
    if (e.key === "Escape" && !pop.hidden) { closePop(); more.focus(); }
    if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) { e.preventDefault(); $("#f-q").focus(); }
  };
  const onScroll = () => { if (!pop.hidden) closePop(); };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, { passive: true });

  // Phone: the same controls open as a bottom sheet so the sticky bar stays one row.
  const controls = $("#fb-controls"), sheetBtn = $("#f-sheet-btn");
  let scrim = null;
  const closeSheet = () => {
    if (!controls.classList.contains("open")) return;
    controls.classList.remove("open");
    sheetBtn.setAttribute("aria-expanded", "false");
    scrim?.classList.remove("open");
    const s = scrim; scrim = null; setTimeout(() => s?.remove(), 220);
    document.body.style.overflow = "";
    controls.removeAttribute("role");
    controls.removeAttribute("aria-modal");
    sheetBtn.focus();
  };
  sheetBtn.addEventListener("click", () => {
    scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.addEventListener("click", closeSheet);
    document.body.appendChild(scrim);
    requestAnimationFrame(() => { scrim.classList.add("open"); controls.classList.add("open"); });
    sheetBtn.setAttribute("aria-expanded", "true");
    controls.setAttribute("role", "dialog");
    controls.setAttribute("aria-modal", "true");
    document.body.style.overflow = "hidden";
    setTimeout(() => $("#f-markets button")?.focus(), 60);
  });
  $("#f-sheet-close").addEventListener("click", closeSheet);
  $("#f-sheet-done").addEventListener("click", closeSheet);
  controls.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop.hidden) closeSheet(); });

  // The column header sticks just under the filter bar, whatever height the bar wraps to.
  const fbRO = new ResizeObserver(() => {
    root.querySelector(".board")?.style.setProperty("--fb-h", `${$("#filterbar").offsetHeight}px`);
    onStickResize();
  });
  fbRO.observe($("#filterbar"));
  const mk = $("#f-markets");
  mk.addEventListener("scroll", fadeMarkets, { passive: true });
  // A mouse wheel scrolls an overflowing chip line sideways; at either end it scrolls the page.
  mk.addEventListener("wheel", (e) => {
    const max = mk.scrollWidth - mk.clientWidth;
    if (max <= 1 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    if ((e.deltaY < 0 && mk.scrollLeft <= 0) || (e.deltaY > 0 && mk.scrollLeft >= max - 1)) return;
    e.preventDefault();
    mk.scrollLeft += e.deltaY;
  }, { passive: false });

  $("#f-tokens").addEventListener("click", (e) => {
    if (e.target.closest("#f-clear")) return clearAll();
    const t = e.target.closest("[data-k]");
    if (!t) return;
    ({ g: state.games, t: state.teams, p: state.pitchers })[t.dataset.k].delete(t.dataset.v);
    commit();
  });

  body.addEventListener("click", (e) => {
    // The sticky strip is a mouse shortcut to the pitcher it names; keyboard users have his real header.
    if (e.target.closest("#pl-stick")) { stickCur?.querySelector("a.plh")?.click(); return; }
    const s = e.target.closest("[data-sort]");
    if (s) {
      const k = s.dataset.sort;
      if (state.sort === k) state.dir = state.dir === "asc" ? "desc" : "asc";
      else { state.sort = k; state.dir = k === "over" || k === "under" ? "desc" : "asc"; }
      writeState(state, setQuery);
      paint();
      body.querySelector(`[data-sort="${k}"]`)?.focus();
      return;
    }
    const x = e.target.closest("[data-expand]");
    if (x) {
      const k = x.dataset.expand;
      if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
      paint();
      body.querySelector(`[data-expand="${CSS.escape(k)}"]`)?.focus();
      return;
    }
    // A click anywhere on a row (outside its links and buttons) opens the pitcher.
    const tr = e.target.closest("tr.bt-row");
    if (tr && !e.target.closest("a, button")) tr.querySelector("a.pl")?.click();
  });
  // Up / down arrows move between rows from any row link.
  body.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key) || !e.target.closest("a.pl, a.plh")) return;
    const links = [...body.querySelectorAll("a.pl, a.plh")];
    const i = links.indexOf(e.target.closest("a.pl, a.plh"));
    const next = links[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  });

  load();
  sessionStorage.setItem("pwr:lastBoard", window.location.search);

  return () => {
    alive = false;
    io?.disconnect();
    fbRO.disconnect();
    window.removeEventListener("scroll", onStickScroll);
    window.removeEventListener("resize", onStickResize);
    cancelAnimationFrame(stickRaf);
    document.documentElement.style.removeProperty("--sticky-offset");
    scrim?.remove();
    document.body.style.overflow = "";
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll);
  };
}

function abbrGame(v) {
  const [a, h] = v.split(" @ ");
  return `${abbr(a)} @ ${abbr(h)}`;
}
