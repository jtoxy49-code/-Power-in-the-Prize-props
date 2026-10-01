// LINEUP MATCHUPS: how the opposing lineup matches up against one starter.
// Pick a date and a game, then a starter; the page establishes the game, the
// pitcher and the lineup he faces (posted batting order, or the honest
// fallback), shows what he throws, then puts every hitter against every pitch
// he throws in one matrix. Real data only: the pitcher's Savant arsenal, each
// hitter's Savant season rows by pitch type, MLB lineups, and batter vs
// pitcher history on request. The rules behind every derived number live in
// matchup-model.js.
import { api } from "../api.js";
import { abbr } from "../domain.js";
import { slateDate, validYmd, gameSlateDate, slateWeekday } from "../dates.js";
import { esc, time, longDay, avg3, pct1, NA } from "../format.js";
import { avatar, pitcherHref, errorState } from "../ui.js";
import { icon } from "../icons.js";
import { buildLineup } from "../components/lineup.js";
import { SHORT, TONES, INK } from "../components/arsenal.js";
import { METRICS, MIN_PA, MIN_PITCHES, MIN_COVERAGE, MIN_USAGE, buildMatchup, edgeOf, rankings, findings, qualifies } from "../matchup-model.js";

const WHIFF_MAX = 60; // stem length scale, same as Player Detail's arsenal
const STEM_PX = 56;   // a 60% whiff rate hangs this far

export function render(root, params, { setQuery }) {
  const today = slateDate(0);
  const state = {
    date: validYmd(params.get("date")) || today,
    game: params.get("game") || null,
    side: ["away", "home"].includes(params.get("p")) ? params.get("p") : null,
    metric: METRICS[params.get("m")] ? params.get("m") : "xba",
    sort: params.get("sort") === "mix" ? "mix" : "order",
  };
  let alive = true;
  let token = 0;
  let day = null;       // { games }
  let ctx = null;       // the selected matchup's data and model
  const open = new Set();
  const bvpCache = new Map();
  let handSplits = null; // Promise of { batter_id -> { whiff_pct, chase_pct } }
  const idsP = api.pitcherIds().catch(() => ({}));

  root.innerHTML = `
    <div class="page matchups">
      <header class="page-head mu-head">
        <div>
          <h1 class="h-page">Lineup matchups</h1>
          <p class="lede">How the opposing lineup matches up against a starter, pitch by pitch.</p>
        </div>
        <label class="date-field">
          <span class="date-label">Game date</span>
          <span class="date-wrap">${icon("calendar-blank")}<input id="m-date" type="date" value="${state.date}"></span>
        </label>
      </header>
      <div class="mu-slate-wrap"><div class="mu-slate" id="mu-slate" role="radiogroup" aria-label="Games"></div></div>
      <div id="mu-body"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const slateEl = $("#mu-slate");
  const body = $("#mu-body");

  const writeUrl = () => setQuery((p) => {
    p.set("view", "matchups");
    if (state.date === today) p.delete("date"); else p.set("date", state.date);
    if (state.game) p.set("game", state.game); else p.delete("game");
    if (state.side) p.set("p", state.side); else p.delete("p");
    if (state.metric !== "xba") p.set("m", state.metric); else p.delete("m");
    if (state.sort === "mix") p.set("sort", "mix"); else p.delete("sort");
  });

  // ---------- the day ----------
  async function loadDay() {
    const my = ++token;
    slateEl.innerHTML = `<span class="mu-g-sk skeleton"></span>`.repeat(4);
    body.innerHTML = skeleton();
    try {
      day = await api.lineups(state.date);
      if (!alive || my !== token) return;
    } catch {
      if (!alive || my !== token) return;
      slateEl.innerHTML = "";
      body.innerHTML = errorState("Couldn't load the schedule.", "The MLB schedule request failed. Try again.", "m-retry");
      $("#m-retry")?.addEventListener("click", loadDay);
      return;
    }
    const games = day.games || [];
    if (!games.length) {
      slateEl.innerHTML = "";
      body.innerHTML = `<div class="mu-empty"><div class="state"><strong>No MLB games on ${esc(longDay(new Date(`${state.date}T12:00:00`)))}.</strong><span>Pick another date to see its starters.</span></div></div>`;
      return;
    }
    // Keep the requested game when it is on this date; otherwise the first game with a named starter.
    if (!games.some((g) => String(g.game_pk) === String(state.game))) {
      state.game = String((games.find((g) => g.away_probable_pitcher || g.home_probable_pitcher) || games[0]).game_pk);
      state.side = null;
    }
    paintSlate();
    loadMatchup();
  }

  function paintSlate() {
    const games = day.games || [];
    slateEl.innerHTML = games.map((g) => {
      const on = String(g.game_pk) === String(state.game);
      const posted = (g.away_lineup_confirmed ? 1 : 0) + (g.home_lineup_confirmed ? 1 : 0);
      const status = g.status && g.status !== "Scheduled" ? g.status : posted === 2 ? "Lineups posted" : posted === 1 ? "1 lineup posted" : "Lineups not posted";
      return `<button type="button" class="mu-g" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-game="${esc(g.game_pk)}">
        <span class="mu-g-t">${esc(time(g.game_time))}</span>
        <span class="mu-g-m">${esc(abbr(g.away_team))}<i>@</i>${esc(abbr(g.home_team))}</span>
        <span class="mu-g-s">${esc(status)}</span>
      </button>`;
    }).join("");
    slateEl.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  // ---------- the matchup ----------
  async function loadMatchup() {
    const my = ++token;
    const g = (day.games || []).find((x) => String(x.game_pk) === String(state.game));
    if (!g) return;
    if (!state.side || !g[`${state.side}_probable_pitcher`]) state.side = g.away_probable_pitcher ? "away" : g.home_probable_pitcher ? "home" : "away";
    writeUrl();
    open.clear();
    handSplits = null;
    const side = state.side, oppSide = side === "away" ? "home" : "away";
    const name = g[`${side}_probable_pitcher`];
    const team = g[`${side}_team`], opp = g[`${oppSide}_team`];
    const base = { g, side, name, team, opp, oppAbbr: abbr(opp), teamAbbr: abbr(team), confirmed: !!g[`${oppSide}_lineup_confirmed`], posted: g[`${oppSide}_lineup`] || [] };
    if (!name) {
      ctx = { ...base };
      body.innerHTML = gameBar(base) + `<div class="mu-empty"><div class="state"><strong>No probable starters are announced for this game yet.</strong><span>MLB usually names them a day or two ahead. Pick another game, or check back.</span></div></div>`;
      return;
    }
    body.innerHTML = gameBar(base) + `<div class="mu-loading" aria-busy="true">${skeleton(true)}</div>`;
    try {
      // A failed request goes to the error state below; an empty answer is shown as empty.
      const [p, tb, ids] = await Promise.all([api.pitcher(name), api.teamBatters(opp), idsP]);
      if (!alive || my !== token) return;
      const stats = p?.matched ? p.stats : null;
      const pitcherId = stats?.player_id || ids[name] || null;
      const lineup = buildLineup(tb, null, base.posted);
      const hitterIds = lineup.batters.map((b) => b.player_id).filter((x) => x != null && /^\d+$/.test(String(x)));
      const [pt, hand] = await Promise.all([
        hitterIds.length ? api.batterPitchTypes(hitterIds) : null,
        pitcherId ? api.pitcherHand(pitcherId).then((d) => d.hand).catch(() => null) : null,
      ]);
      if (!alive || my !== token) return;
      const model = buildMatchup({ arsenal: stats?.arsenal || [], batters: lineup.batters, rowsById: pt?.batters || {}, league: pt?.league || {} });
      ctx = { ...base, stats, pitcherId, hand, lineup, model, pt, teamBatters: tb, last: String(name).split(" ").slice(-1)[0] };
      paintMatchup();
    } catch {
      if (!alive || my !== token) return;
      body.innerHTML = gameBar(base) + errorState("Couldn't load this matchup.", "One of the matchup requests failed. Try again.", "mu-retry");
      $("#mu-retry")?.addEventListener("click", loadMatchup);
    }
  }

  function gameBar({ g, side }) {
    const opt = (s) => {
      const n = g[`${s}_probable_pitcher`];
      const vs = abbr(g[`${s === "away" ? "home" : "away"}_team`]);
      const on = s === side;
      return `<button type="button" role="radio" aria-checked="${on}" data-side="${s}" ${n ? "" : 'disabled aria-disabled="true"'}>${esc(n ? n.split(" ").slice(-1)[0] : "TBD")}<span class="seg-meta">vs ${esc(vs)}</span></button>`;
    };
    return `
      <div class="mu-gamebar">
        <span class="mu-gb-teams">${esc(abbr(g.away_team))}<i>@</i>${esc(abbr(g.home_team))}</span>
        <span class="mu-gb-when">${esc(slateWeekday(gameSlateDate(g.game_time)))} ${esc(time(g.game_time))}</span>
        ${g.venue ? `<span class="mu-gb-venue">${esc(g.venue)}</span>` : ""}
        ${g.status && g.status !== "Scheduled" ? `<span class="game-status ${/progress|warmup|challenge|review/i.test(g.status) ? "gs-live" : /delay|postpon|suspend|cancel/i.test(g.status) ? "gs-alert" : ""}">${esc(g.status)}</span>` : ""}
        <div class="seg mu-sidesel" role="radiogroup" aria-label="Starter">${opt("away")}${opt("home")}</div>
      </div>`;
  }

  function paintMatchup() {
    const c = ctx;
    const m = c.model;
    const href = pitcherHref({ name: c.name, opponent: c.opp, home_team: c.g.home_team, game_time: c.g.game_time, matchup: `${c.g.away_team} @ ${c.g.home_team}`, team: c.team });
    const s = c.stats?.season, x = c.stats?.expected;
    const line = [["IP", s?.innings_pitched ?? null], ["K%", s?.k_pct != null ? `${s.k_pct.toFixed(1)}%` : null], ["BB%", s?.bb_pct != null ? `${s.bb_pct.toFixed(1)}%` : null], ["ERA", s?.era != null ? s.era.toFixed(2) : null], ["xBA", x?.est_ba != null ? avg3(x.est_ba) : null]].filter(([, v]) => v != null);
    const handWord = c.hand === "L" ? "Left-handed" : c.hand === "R" ? "Right-handed" : null;
    const noHitters = !c.lineup.batters.length;
    body.innerHTML = `
      ${gameBar(c)}
      <section class="mu-vs" aria-labelledby="mu-title">
        <div class="mu-p">
          ${avatar(c.name, c.pitcherId, 84, "mu-p-face")}
          <div class="mu-p-t">
            <h2 class="mu-p-name" id="mu-title">${esc(c.name)}</h2>
            <p class="mu-p-meta">${handWord ? `${handWord} ` : ""}${esc(c.teamAbbr)} starter</p>
            ${line.length ? `<dl class="mu-p-line"><div><dt>2026</dt><dd></dd></div>${line.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${esc(v)}</dd></div>`).join("")}</dl>` : ""}
            <a class="mu-p-link" href="${esc(href)}" data-link>Open ${esc(c.last)}'s scouting report${icon("caret-right")}</a>
          </div>
        </div>
        <span class="mu-vs-word" aria-hidden="true">vs</span>
        <div class="mu-o">
          <span class="mu-o-abbr">${esc(c.oppAbbr)}</span>
          <span class="mu-o-name">${esc(c.opp)}</span>
          ${noHitters ? `<span class="mu-lu off">No hitter data</span>` : c.lineup.confirmed
            ? `<span class="mu-lu on">${icon("check")}Batting order posted</span><p class="mu-lu-note">Posted by MLB.</p>`
            : `<span class="mu-lu off">Lineup not posted</span><p class="mu-lu-note">Until MLB posts it, these are the nine ${esc(c.oppAbbr)} hitters with the most plate appearances, ranked by PA. Not a batting order.</p>`}
        </div>
      </section>
      ${m.cols.length ? arsenalHtml(c) : `<section class="mu-ars"><div class="mu-sec-h"><h3>What he throws</h3></div><p class="mu-note">No pitch-mix data for ${esc(c.name)} in 2026 yet, so there's nothing to match the lineup against. The lineup is below with season lines only.</p></section>`}
      ${noHitters ? `<div class="mu-empty"><div class="state"><strong>No hitter data for ${esc(c.opp)} yet.</strong><span>Hitter stats refresh twice a day.</span></div></div>` : `
      <div id="mu-sum">${summaryHtml()}</div>
      <section class="mu-mx" aria-labelledby="mu-mx-h">
        <div class="mu-mx-bar">
          <div class="mu-sec-h"><h3 id="mu-mx-h">Hitter by pitch</h3><span>${esc(c.oppAbbr)} hitters against each pitch ${esc(c.last)} throws ${MIN_USAGE}% of the time or more</span></div>
          <div class="seg" id="mu-metric" role="radiogroup" aria-label="Matrix metric">
            ${Object.entries(METRICS).map(([id, mm]) => `<button type="button" role="radio" data-metric="${id}" aria-checked="${state.metric === id}">${mm.label}</button>`).join("")}
          </div>
        </div>
        <div id="mu-matrix">${matrixHtml()}</div>
      </section>`}`;
  }

  // ---------- what he throws ----------
  function arsenalHtml(c) {
    const { cols, minor } = c.model;
    const total = (c.stats?.arsenal || []).reduce((s, p) => s + (p.pitches || 0), 0);
    const tone = (i) => `--tone:${TONES[Math.min(i, TONES.length - 1)]};--ink:${INK[Math.min(i, INK.length - 1)]}`;
    const usageSum = cols.reduce((s, p) => s + p.usage, 0);
    return `
      <section class="mu-ars" aria-labelledby="mu-ars-h">
        <div class="mu-sec-h"><h3 id="mu-ars-h">What he throws</h3><span>2026${total ? `, ${total.toLocaleString()} pitches` : ""}</span></div>
        <div class="mu-band" role="img" aria-label="Usage: ${esc(cols.map((p) => `${p.name} ${p.usage.toFixed(1)}%`).join(", "))}">
          ${cols.map((p) => `<span class="mu-sl" style="flex-grow:${p.usage};${tone(p.rank)}"><b>${esc(short(p))}</b><i>${p.usage.toFixed(1)}%</i></span>`).join("")}
        </div>
        <div class="mu-stems" role="img" aria-label="Whiff per swing: ${esc(cols.map((p) => `${p.name} ${p.whiff == null ? "not recorded" : `${p.whiff.toFixed(1)}%`}`).join(", "))}">
          ${cols.map((p) => `<span class="mu-st" style="flex-grow:${p.usage}"><span class="mu-stem" style="${tone(p.rank)};height:${p.whiff == null ? 0 : Math.min(STEM_PX, (p.whiff / WHIFF_MAX) * STEM_PX).toFixed(1)}px"></span><b>${p.whiff == null ? "-" : `${p.whiff.toFixed(1)}<small>%</small>`}</b></span>`).join("")}
        </div>
        <p class="mu-key"><span><i class="mu-key-u"></i>Width: share of his pitches</span><span><i class="mu-key-w"></i>Stem: his whiff rate per swing on that pitch</span>${minor.length ? `<span>Also throws ${esc(minor.map((p) => `${p.name}${p.usage != null ? ` (${p.usage.toFixed(1)}%)` : ""}`).join(", "))}, under ${MIN_USAGE}%: left out of the matrix.</span>` : ""}${usageSum < 99.5 && !minor.length ? "" : ""}</p>
      </section>`;
  }

  // ---------- summary: findings and rankings ----------
  function summaryHtml() {
    const c = ctx, m = c.model;
    if (!m.cols.length) return "";
    const f = findings(m, { pitcherLast: c.last, oppAbbr: c.oppAbbr });
    const mm = METRICS[state.metric];
    const r = rankings(m, state.metric);
    const fmt = (v) => (state.metric === "xba" ? avg3(v) : `${v.toFixed(1)}%`);
    const list = (title, arr) => `
      <div class="mu-rk">
        <h4>${title}</h4>
        <ol>${arr.map(({ h, v }) => `<li><span class="mu-rk-o">${h.order}</span>${avatar(h.name, h.player_id, 32)}<span class="mu-rk-n">${esc(h.name)}</span><b class="mu-rk-v">${fmt(v)}</b></li>`).join("")}</ol>
      </div>`;
    const lgw = m.leagueWeighted[state.metric];
    const rank = !mm.weighted
      ? `<p class="mu-note">Whiff% is per swing, and swings by pitch type aren't in the data, so it isn't blended into one figure or ranked. Read it pitch by pitch in the matrix.</p>`
      : r?.tooFew
        ? `<p class="mu-note">Only ${r.n} ${r.n === 1 ? "hitter has" : "hitters have"} enough plate appearances against ${esc(c.last)}'s pitches for a weighted ${mm.label}, too few to rank.</p>`
        : `<div class="mu-rks">${list(`Best hitter matchups<small>${mm.hitterBetter === "high" ? "Highest" : "Lowest"} ${mm.label} vs his mix</small>`, r.best)}${list(`Toughest hitter matchups<small>${mm.hitterBetter === "high" ? "Lowest" : "Highest"} ${mm.label} vs his mix</small>`, r.toughest)}</div>
           ${lgw != null ? `<p class="mu-note">An MLB-average hitter against the same mix: <b>${fmt(lgw)}</b>.</p>` : ""}`;
    return `
      <section class="mu-sum" aria-labelledby="mu-sum-h">
        <div class="mu-sec-h"><h3 id="mu-sum-h">${esc(c.oppAbbr)} lineup vs ${esc(c.last)}'s mix</h3></div>
        <div class="mu-sum-grid">
          ${f.length ? `<ul class="mu-finds">${f.map((x) => `<li>${x.html}</li>`).join("")}</ul>` : `<p class="mu-note">Not enough pitch-level data on these hitters for findings.</p>`}
          <div class="mu-sum-r">${rank}</div>
        </div>
      </section>`;
  }

  // ---------- the matrix ----------
  function matrixHtml() {
    const c = ctx, m = c.model, metric = state.metric, mm = METRICS[metric];
    if (!m.cols.length) return seasonOnlyList();
    const hitters = sortedHitters();
    const posted = c.lineup.confirmed;
    const lg = (type) => m.league?.[type]?.[mm.key];
    const fmt = (v) => (v == null ? "-" : metric === "xba" ? avg3(v) : `${v.toFixed(1)}%`);
    const sampleTxt = (r) => (r ? (mm.sample === "pa" ? `${r.pa} PA` : `${(r.pitches || 0).toLocaleString()} pitches`) : "No PA");
    const cellCls = (r, l) => {
      if (!r) return "none";
      if (r[mm.key] == null) return "none";
      if (!qualifies(r, metric)) return "thin";
      const e = edgeOf(r[mm.key], l, metric);
      return e ? `e-${e.side}${e.strength === "strong" ? " e-strong" : ""}` : "";
    };
    const cellLabel = (h, p, r, l) => {
      if (!r) return `${h.name} has no plate appearances against ${p.name}s in 2026`;
      if (r[mm.key] == null) return `${h.name} vs ${p.name}: ${mm.label} not recorded, ${sampleTxt(r)}`;
      const e = qualifies(r, metric) ? edgeOf(r[mm.key], l, metric) : null;
      const edge = e ? (e.side === "hitter" ? ", hitter's edge" : e.side === "pitcher" ? ", pitcher's edge" : ", about MLB average") : ", small sample";
      return `${h.name} vs ${p.name}: ${mm.label} ${fmt(r[mm.key])} over ${sampleTxt(r)}${l != null ? `, MLB ${fmt(l)}` : ""}${edge}`;
    };
    const cell = (h, p) => {
      const r = h.cells[p.type];
      const l = lg(p.type);
      return `<td class="mx-c ${cellCls(r, l)}" aria-label="${esc(cellLabel(h, p, r, l))}"><b>${r && r[mm.key] != null ? fmt(r[mm.key]) : "-"}</b><i>${esc(r && r[mm.key] == null ? "Not recorded" : sampleTxt(r))}</i></td>`;
    };
    const mix = (h) => {
      if (!mm.weighted) return "";
      const w = h.weighted[metric];
      const cov = w ? Math.round(w.coverage * 100) : 0;
      return `<td class="mx-mix ${w?.ok ? "" : "none"}" aria-label="${esc(w?.ok ? `${h.name} vs ${c.last}'s mix: ${mm.label} ${fmt(w.value)}, covering ${cov}% of his plate appearances` : `${h.name}: not enough data for a weighted figure (${cov}% covered)`)}"><b>${w?.ok ? fmt(w.value) : "-"}</b><i>${w?.ok ? (cov < 100 ? `covers ${cov}%` : "covers all") : cov ? `only ${cov}% covered` : "no data"}</i></td>`;
    };
    const nCols = m.cols.length + 2 + (mm.weighted ? 1 : 0);
    const lgw = m.leagueWeighted[metric];
    const lineupCells = m.cols.map((p) => {
      const r = m.lineup[p.type];
      const l = lg(p.type);
      const has = r && r[mm.key] != null;
      return `<td class="mx-c ${has ? cellCls(r, l) : "none"}"><b>${has ? fmt(r[mm.key]) : "-"}</b><i>${has ? esc(sampleTxt(r)) : "No data"}</i></td>`;
    }).join("");
    const lw = m.lineupWeighted[metric];
    return `
      <p class="mx-key" aria-hidden="true">
        <span><i class="k-p2"></i><i class="k-p1"></i>Pitcher's edge</span>
        <span><i class="k-0"></i>About MLB average</span>
        <span><i class="k-h1"></i><i class="k-h2"></i>Hitter's edge</span>
        <span><i class="k-thin">12</i>Under ${mm.sample === "pa" ? `${MIN_PA} PA` : `${MIN_PITCHES} pitches`}: small sample, not shaded</span>
      </p>
      <div class="mx-wrap">
        <table class="mx ${posted ? "posted" : "ranked"}" style="--cols:${m.cols.length}">
          <caption class="sr-only">${esc(c.oppAbbr)} hitters' 2026 ${mm.label} against each pitch ${esc(c.name)} throws, compared with MLB hitters on the same pitch.${mm.weighted ? ` The last column weights each hitter's values by how often ${esc(c.last)}'s plate appearances end on that pitch.` : ""} Select a hitter for his full breakdown.</caption>
          <thead><tr>
            <th scope="col" class="mx-h-who">${posted ? "Batting order" : "Ranked by PA"}</th>
            ${m.cols.map((p) => `<th scope="col" class="mx-h-p" style="--tone:${TONES[Math.min(p.rank, TONES.length - 1)]}">
              <span class="mx-h-name"><i class="mx-sw" aria-hidden="true"></i>${esc(short(p))}</span>
              <span class="mx-h-use"><span class="mx-use-bar" aria-hidden="true"><span style="width:${Math.min(100, p.usage / Math.max(...m.cols.map((q) => q.usage)) * 100).toFixed(1)}%"></span></span>${p.usage.toFixed(1)}% of pitches</span>
              <span class="mx-h-lg">MLB ${lg(p.type) != null ? fmt(lg(p.type)) : "n/a"}</span>
            </th>`).join("")}
            ${mm.weighted ? `<th scope="col" class="mx-h-mix" aria-sort="${state.sort === "mix" ? (mm.hitterBetter === "high" ? "descending" : "ascending") : "none"}"><button type="button" class="sort" data-sort-mix>vs his mix${icon(state.sort === "mix" ? "caret-down" : "caret-up-down")}</button><span class="mx-h-use">${mm.label} weighted by where his PAs end</span><span class="mx-h-lg">MLB hitter ${lgw != null ? fmt(lgw) : "n/a"}</span></th>` : ""}
            <th scope="col" class="mx-h-x"><span class="sr-only">Details</span></th>
          </tr></thead>
          <tbody>
            ${hitters.map((h, i) => `
              <tr class="mx-row${posted && state.sort === "order" && (h.order === 3 || h.order === 6) ? " mx-break" : ""}${open.has(String(h.player_id)) ? " open" : ""}" data-id="${esc(h.player_id)}">
                <th scope="row" class="mx-who">
                  <button type="button" class="mx-who-b" data-open="${esc(h.player_id)}" aria-expanded="${open.has(String(h.player_id))}" aria-controls="mx-d-${esc(h.player_id)}">
                    <span class="mx-ord" aria-label="${posted ? `Batting ${h.order}` : `Rank ${h.order} by plate appearances`}">${h.order}</span>
                    ${avatar(h.name, h.player_id, 40)}
                    <span class="mx-id"><span class="mx-name">${esc(h.name)}</span><span class="mx-sub">${h.pa != null ? `${h.pa} PA in 2026` : "No 2026 season line"}</span></span>
                  </button>
                </th>
                ${m.cols.map((p) => cell(h, p)).join("")}
                ${mix(h)}
                <td class="mx-x" aria-hidden="true">${icon("caret-down", open.has(String(h.player_id)) ? "flip" : "")}</td>
              </tr>
              <tr class="mx-detail" id="mx-d-${esc(h.player_id)}" ${open.has(String(h.player_id)) ? "" : "hidden"}><td colspan="${nCols}">${open.has(String(h.player_id)) ? inspector(h) : ""}</td></tr>`).join("")}
            <tr class="mx-lineup">
              <th scope="row" class="mx-who"><span class="mx-lu-l">${esc(c.oppAbbr)} lineup<small>combined</small></span></th>
              ${lineupCells}
              ${mm.weighted ? `<td class="mx-mix ${lw?.ok ? "" : "none"}"><b>${lw?.ok ? fmt(lw.value) : "-"}</b><i>${lw?.ok ? "vs his mix" : "not enough data"}</i></td>` : ""}
              <td class="mx-x"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <ol class="ml${posted ? "" : " ml-ranked"}" aria-label="${esc(c.oppAbbr)} hitters">${hitters.map((h) => mobileHitter(h)).join("")}</ol>
      ${methodHtml()}`;
  }

  // Phone and tablet: one hitter at a time, his matchup read first, every pitch beneath.
  function mobileHitter(h) {
    const c = ctx, m = c.model, metric = state.metric, mm = METRICS[metric];
    const id = String(h.player_id);
    const isOpen = open.has(id);
    const fmt = (v) => (v == null ? "-" : metric === "xba" ? avg3(v) : `${v.toFixed(1)}%`);
    const lg = (type) => m.league?.[type]?.[mm.key];
    const q = m.cols.map((p) => ({ p, r: h.cells[p.type] })).filter(({ r }) => qualifies(r, metric))
      .map((x) => ({ ...x, e: edgeOf(x.r[mm.key], lg(x.p.type), metric) })).filter((x) => x.e);
    q.sort((a, b) => b.e.delta - a.e.delta);
    const best = q[0], worst = q.length > 1 ? q[q.length - 1] : null;
    const w = mm.weighted ? h.weighted[metric] : null;
    const lead = w?.ok
      ? `<span class="ml-mix"><b>${fmt(w.value)}</b> ${mm.label} vs his mix</span>`
      : mm.weighted ? `<span class="ml-mix none">No weighted ${mm.label}: ${w && w.coverage ? `only ${Math.round(w.coverage * 100)}% of his PA covered` : "no qualifying pitches"}</span>` : "";
    const finding = !h.hasData
      ? "No 2026 pitch-type data for this hitter."
      : q.length
        ? `Best vs ${short(best.p)} (${fmt(best.r[mm.key])})${worst && worst !== best ? `, toughest vs ${short(worst.p)} (${fmt(worst.r[mm.key])})` : ""}`
        : `Every pitch is a small sample for ${mm.label}.`;
    return `
      <li class="ml-h${isOpen ? " open" : ""}" data-id="${esc(id)}">
        <button type="button" class="ml-head" data-open="${esc(id)}" aria-expanded="${isOpen}" aria-controls="ml-d-${esc(id)}">
          <span class="mx-ord" aria-label="${c.lineup.confirmed ? `Batting ${h.order}` : `Rank ${h.order} by plate appearances`}">${h.order}</span>
          ${avatar(h.name, h.player_id, 44)}
          <span class="ml-id"><span class="mx-name">${esc(h.name)}</span>${lead}<span class="ml-find">${esc(finding)}</span></span>
          <span class="ml-caret">${icon("caret-down", isOpen ? "flip" : "")}</span>
        </button>
        <ul class="ml-chips" aria-label="${esc(mm.label)} by pitch">
          ${m.cols.map((p) => {
            const r = h.cells[p.type];
            const has = r && r[mm.key] != null;
            const e = has && qualifies(r, metric) ? edgeOf(r[mm.key], lg(p.type), metric) : null;
            return `<li class="ml-chip ${!has ? "none" : !qualifies(r, metric) ? "thin" : e ? `e-${e.side}${e.strength === "strong" ? " e-strong" : ""}` : ""}" style="--tone:${TONES[Math.min(p.rank, TONES.length - 1)]}"><i>${esc(short(p))}</i><b>${has ? fmt(r[mm.key]) : "-"}</b><small>${r ? esc(mm.sample === "pa" ? `${r.pa} PA` : `${r.pitches} P`) : "No PA"}</small></li>`;
          }).join("")}
        </ul>
        <div class="ml-detail" id="ml-d-${esc(id)}" ${isOpen ? "" : "hidden"}>${isOpen ? inspector(h) : ""}</div>
      </li>`;
  }

  function sortedHitters() {
    const m = ctx.model, mm = METRICS[state.metric];
    const hs = m.hitters.slice();
    if (state.sort === "mix" && mm.weighted) {
      const val = (h) => (h.weighted[state.metric]?.ok ? h.weighted[state.metric].value : null);
      hs.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null && vb == null) return a.order - b.order;
        if (va == null) return 1;
        if (vb == null) return -1;
        return mm.hitterBetter === "high" ? vb - va : va - vb;
      });
    }
    return hs;
  }

  function seasonOnlyList() {
    const c = ctx;
    return `<ol class="mu-season">${c.lineup.batters.map((b) => `<li><span class="mx-ord">${b.order}</span>${avatar(b.name, b.player_id, 40)}<span class="mx-name">${esc(b.name)}</span><span class="num">${b.pa != null ? `${b.pa} PA` : ""} ${avg3(b.ba)}/${avg3(b.obp)}/${avg3(b.slg)} K ${pct1(b.k_pct)}</span></li>`).join("")}</ol>`;
  }

  function methodHtml() {
    const c = ctx, mm = METRICS[state.metric];
    const updated = c.pt?.updated_at ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(c.pt.updated_at)) : null;
    return `
      <div class="mu-method">
        <p>Each cell is the hitter's 2026 ${mm.label} (${mm.name}) against that pitch type from every pitcher, shaded against MLB hitters on the same pitch. Pitch-type stats from Baseball Savant${updated ? `, updated ${updated}` : ""}. Batter handedness isn't in the data, so nothing here is split by hand.</p>
        <details>
          <summary>How "vs his mix" is calculated</summary>
          <p><b>vs his mix = Σ (w × v) ÷ Σ w</b>, where v is the hitter's xBA or K% against a pitch type and w is the share of ${esc(c.name)}'s 2026 plate appearances that ended on that pitch. Only pitches in the matrix where the hitter has at least ${MIN_PA} PA and a recorded value count; the weights of the pitches used are rescaled to 100%. No figure is shown when those pitches cover less than ${Math.round(MIN_COVERAGE * 100)}% of his plate appearances. "MLB hitter" applies the same weights to the MLB averages.</p>
          <p>It describes how each hitter has done against this kind of pitch mix. It is not a projection: it doesn't account for handedness, pitch quality, location or sequencing, and the hitter's numbers come from every pitcher, not this one. Whiff% is per swing; swings by pitch type aren't in the data, so it is never weighted. The lineup row pools the hitters' rows by PA (by pitches seen for Whiff%). Shading bands are display ranges, not significance tests: xBA ±.020 and ±.050, Whiff% and K% ±3 and ±8 points.</p>
        </details>
      </div>`;
  }

  // ---------- one hitter in depth ----------
  function inspector(h) {
    const c = ctx, m = c.model;
    const id = String(h.player_id);
    const rows = m.cols.map((p) => ({ p, r: h.cells[p.type] }));
    const v3 = (v) => (v == null ? NA : avg3(v));
    const vp = (v) => (v == null ? NA : `${v.toFixed(1)}%`);
    return `
      <div class="ins">
        <div class="ins-col ins-pitch">
          <h4>Against each of ${esc(c.last)}'s pitches, 2026</h4>
          ${h.hasData ? `<div class="table-scroll"><table class="dt ins-t">
            <thead><tr><th scope="col">Pitch</th><th scope="col">PA</th><th scope="col">Pitches</th><th scope="col">BA</th><th scope="col">xBA</th><th scope="col">Whiff%</th><th scope="col">K%</th><th scope="col">Hard-hit%</th></tr></thead>
            <tbody>${rows.map(({ p, r }) => `<tr class="${r && r.pa >= MIN_PA ? "" : "thin"}"><th scope="row" class="txt"><i class="mx-sw" style="--tone:${TONES[Math.min(p.rank, TONES.length - 1)]}" aria-hidden="true"></i>${esc(p.name)}</th>${r ? `<td>${r.pa}</td><td>${(r.pitches || 0).toLocaleString()}</td><td>${v3(r.ba)}</td><td>${v3(r.est_ba)}</td><td>${vp(r.whiff_pct)}</td><td>${vp(r.k_pct)}</td><td>${vp(r.hard_hit_pct)}</td>` : `<td colspan="7" class="txt faint">No plate appearances against this pitch type in 2026</td>`}</tr>`).join("")}</tbody>
          </table></div>
          <p class="mu-note">Rows under ${MIN_PA} PA are dimmed as small samples. BA and xBA are per at-bat, K% per PA, Whiff% per swing.</p>` : `<p class="mu-note">No 2026 pitch-type data for ${esc(h.name)}.</p>`}
        </div>
        <div class="ins-col ins-season">
          <h4>2026 season</h4>
          <dl class="ins-kv">
            <div><dt>PA</dt><dd class="num">${h.pa ?? NA}</dd></div>
            <div><dt>AVG/OBP/SLG</dt><dd class="num">${v3(h.ba)}/${v3(h.obp)}/${v3(h.slg)}</dd></div>
            <div><dt>HR</dt><dd class="num">${h.hr ?? NA}</dd></div>
            <div><dt>K%</dt><dd class="num">${vp(h.k_pct)}</dd></div>
            <div><dt>BB%</dt><dd class="num">${vp(h.bb_pct)}</dd></div>
          </dl>
          ${c.hand ? `<h4>vs ${c.hand === "L" ? "left" : "right"}-handed pitching, last 60 days</h4><div class="ins-hand" data-hand-for="${esc(id)}"><span class="faint">Loading…</span></div>` : ""}
        </div>
        <div class="ins-col ins-bvp">
          <h4>vs ${esc(c.name)}, last 3 seasons</h4>
          <div class="ins-bvp-b" data-bvp-for="${esc(id)}">${c.pitcherId ? `<span class="faint">Loading…</span>` : `<span class="faint">Pitcher ID unavailable, so matchup history can't load.</span>`}</div>
        </div>
      </div>`;
  }

  async function fillInspector(id) {
    const c = ctx;
    if (!c) return;
    // Batter vs pitcher, fetched only when a hitter is opened.
    if (c.pitcherId) {
      if (!bvpCache.has(id)) bvpCache.set(id, api.batterVsPitcher(id, c.pitcherId).catch(() => null));
      bvpCache.get(id).then((d) => {
        if (!alive || ctx !== c) return;
        body.querySelectorAll(`[data-bvp-for="${CSS.escape(id)}"]`).forEach((el) => { el.innerHTML = bvpHtml(d, c); });
      });
    }
    // The real pitcher-hand split (60 days of pitches), fetched once per matchup when first needed.
    if (c.hand) {
      handSplits ||= api.teamSplits(c.opp, { hand: c.hand }).then((d) => new Map((d?.batters || []).map((b) => [String(b.batter_id), b]))).catch(() => null);
      handSplits.then((map) => {
        if (!alive || ctx !== c) return;
        const b = map?.get(id);
        body.querySelectorAll(`[data-hand-for="${CSS.escape(id)}"]`).forEach((el) => {
          el.innerHTML = !map ? `<span class="faint">Couldn't load this split.</span>`
            : !b ? `<span class="faint">No pitches seen from ${c.hand === "L" ? "lefties" : "righties"} in the last 60 days.</span>`
            : `<dl class="ins-kv"><div><dt>Whiff%</dt><dd class="num">${pct1(b.whiff_pct)}</dd></div><div><dt>Chase%</dt><dd class="num">${pct1(b.chase_pct)}</dd></div><div><dt>Pitches</dt><dd class="num">${b.pitches_seen ?? NA}</dd></div></dl>`;
        });
      });
    }
  }

  // The sample leads, the rate follows: 2-for-3 must not read like evidence.
  function bvpHtml(d, c) {
    if (!d) return `<span class="faint">Couldn't load matchup history. Close and reopen to retry.</span>`;
    if (!d.pa) return `<p class="ins-bvp-none">No plate appearances against ${esc(c.last)} in the last 3 seasons.</p>`;
    const pts = (d.pitch_types || []).filter((p) => p.pa > 0);
    const size = d.pa < 10 ? "Very small sample" : d.pa < 30 ? "Small sample" : "Sample";
    return `
      <div class="bvp-lead"><b>${d.pa}</b><span>PA</span><em>${size}: read it as history, not a rate.</em></div>
      <dl class="ins-kv">
        <div><dt>H-AB</dt><dd class="num">${d.hits ?? NA}-${d.ab ?? NA}</dd></div>
        <div><dt>AVG</dt><dd class="num">${d.ba != null ? avg3(d.ba) : NA}</dd></div>
        <div><dt>K</dt><dd class="num">${d.strikeouts ?? NA}</dd></div>
        <div><dt>BB</dt><dd class="num">${d.walks ?? NA}</dd></div>
        <div><dt>HR</dt><dd class="num">${d.home_runs ?? NA}</dd></div>
      </dl>
      ${pts.length ? `<div class="table-scroll"><table class="dt ins-t"><thead><tr><th scope="col">Pitch</th><th scope="col">PA</th><th scope="col">BA</th><th scope="col">Whiff%</th><th scope="col">K%</th></tr></thead>
        <tbody>${pts.map((p) => `<tr><th scope="row" class="txt">${esc(p.pitch_name || p.pitch_type)}</th><td>${p.pa}</td><td>${p.ba != null ? avg3(p.ba) : NA}</td><td>${pct1(p.whiff_pct)}</td><td>${pct1(p.k_pct)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  }

  // ---------- events ----------
  function selectGame(pk, focus) {
    if (String(pk) === String(state.game)) return;
    state.game = String(pk);
    state.side = null;
    paintSlate();
    if (focus) slateEl.querySelector(`[data-game="${CSS.escape(String(pk))}"]`)?.focus();
    loadMatchup();
  }
  slateEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-game]");
    if (b) selectGame(b.dataset.game);
  });
  slateEl.addEventListener("keydown", (e) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    const items = [...slateEl.querySelectorAll("[data-game]")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    selectGame(items[n].dataset.game, true);
  });

  function toggle(id) {
    if (open.has(id)) open.delete(id); else open.add(id);
    const isOpen = open.has(id);
    body.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((row) => row.classList.toggle("open", isOpen));
    body.querySelectorAll(`[data-open="${CSS.escape(id)}"]`).forEach((b) => {
      b.setAttribute("aria-expanded", String(isOpen));
      const target = body.querySelector(`#${CSS.escape(b.getAttribute("aria-controls"))}`);
      if (!target) return;
      target.hidden = !isOpen;
      const slot = target.tagName === "TR" ? target.firstElementChild : target;
      if (isOpen) slot.innerHTML = inspector(ctx.model.hitters.find((h) => String(h.player_id) === id));
    });
    body.querySelectorAll(`.mx-row[data-id="${CSS.escape(id)}"] .mx-x svg, .ml-h[data-id="${CSS.escape(id)}"] .ml-caret svg`).forEach((s) => s.classList.toggle("flip", isOpen));
    if (isOpen) fillInspector(id);
  }

  body.addEventListener("click", (e) => {
    const side = e.target.closest("[data-side]");
    if (side && !side.disabled) {
      if (side.dataset.side !== state.side) { state.side = side.dataset.side; loadMatchup(); }
      return;
    }
    const met = e.target.closest("[data-metric]");
    if (met) {
      if (met.dataset.metric === state.metric) return;
      state.metric = met.dataset.metric;
      if (!METRICS[state.metric].weighted) state.sort = "order";
      writeUrl();
      body.querySelectorAll("[data-metric]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.metric === state.metric)));
      $("#mu-matrix").innerHTML = matrixHtml();
      $("#mu-sum").innerHTML = summaryHtml();
      open.forEach((id) => fillInspector(id));
      return;
    }
    if (e.target.closest("[data-sort-mix]")) {
      state.sort = state.sort === "mix" ? "order" : "mix";
      writeUrl();
      $("#mu-matrix").innerHTML = matrixHtml();
      open.forEach((id) => fillInspector(id));
      body.querySelector("[data-sort-mix]")?.focus();
      return;
    }
    const o = e.target.closest("[data-open]");
    if (o) { toggle(o.dataset.open); return; }
    // A click anywhere on a matrix row (outside links and buttons) opens the hitter.
    const tr = e.target.closest("tr.mx-row");
    if (tr && !e.target.closest("a, button")) toggle(tr.dataset.id);
  });
  // Up and down arrows move between hitters.
  body.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp"].includes(e.key) || !e.target.closest(".mx-who-b, .ml-head")) return;
    const sel = e.target.closest(".mx-who-b") ? ".mx-who-b" : ".ml-head";
    const all = [...body.querySelectorAll(sel)];
    const next = all[all.indexOf(e.target.closest(sel)) + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  });

  $("#m-date").addEventListener("change", (e) => {
    if (!validYmd(e.target.value)) return;
    state.date = e.target.value;
    state.game = null;
    state.side = null;
    writeUrl();
    loadDay();
  });

  loadDay();
  return () => { alive = false; };
}

function short(p) {
  return SHORT[p.type] || p.name;
}

function skeleton(inner) {
  return `<div class="mu-sk"${inner ? "" : ' aria-busy="true"'}><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>`;
}
