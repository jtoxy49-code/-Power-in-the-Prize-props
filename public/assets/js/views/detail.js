// PITCHER DETAIL, read like a scouting report:
//   1. Ticket: who, which prop, which line, best price, how it has hit.
//   2. The game log against that line.
//   3. Report sections, each opened by one fact computed from the data,
//      in the order a bettor checks them: lineup, pitch matchup, arsenal,
//      same-handed starters, team splits, season profile.
//   A rail keeps the game, weather and park in view on wide screens.
import { api } from "../api.js";
import {
  STATS, SAMPLES, STATKEY_TO_MARKET, MARKET_TO_STATKEY, LEAGUE_AVG, marketLabel, abbr, bookLabel, bookName,
  gamesForSample, hitRate, avg, loadSlate, isMainLine, bestOdds, initialsFor, headshot, playerCutout, playerAction, weightedAvg,
  nameKey, scheduleFor, groupRows, statOf, isHit, startsOf, ROOFS, postseasonCount,
} from "../domain.js";
import { esc, NA, time, relDay, ago, dateShort, odds as fmtOdds, oddsText, pct1, avg3, fix1, fix2, implied, line as fmtLine } from "../format.js";
import { icon } from "../icons.js";
import { mountGameLog, sampleAverages } from "../components/gamelog.js";
import { arsenalTable, arsenalFact, platoonUsage, pitchDuel, arsenalSystem, platoonFact } from "../components/arsenal.js";
import { buildLineup, lineupCard, wireBvp, productionSummary, teamSplitTable, productionTable } from "../components/lineup.js";
import { evidenceLedger, evidenceSummary } from "../components/evidence.js";
import { opponentModel, opponentFact, opponentProfile, drawProfilePlot, gradecard } from "../components/profile.js";

const SECTIONS = [
  ["lineup", "Lineup"],
  ["pitches", "Pitch matchup"],
  ["arsenal", "Arsenal"],
  ["samehand", "Same-handed"],
  ["splits", "Team splits"],
  ["season", "Season"],
];

export function render(root, params, { setQuery, boardHref }) {
  const ctx = {
    name: params.get("pitcher") || "",
    line: params.has("line") && params.get("line") !== "" ? Number(params.get("line")) : null,
    selection: params.get("selection") || null,
    statKey: params.get("statKey") || "strikeouts",
    opponent: params.get("opponent") || null,
    home_team: params.get("home_team") || null,
    game_time: params.get("game_time") || null,
    matchup: params.get("matchup") || "",
    team: params.get("team") || null,
    sample: SAMPLES.some((s) => s.key === params.get("sample")) ? params.get("sample") : "L10",
    player_id: null,
  };
  if (ctx.line != null && !ctx.selection) ctx.selection = "Over";
  if (!ctx.team && ctx.matchup.includes(" @ ") && ctx.opponent) {
    const [a, h] = ctx.matchup.split(" @ ");
    ctx.team = ctx.opponent === h ? a : h;
  }
  let alive = true;
  let games = [];
  // What one game-log entry counts as: "start" (MLB's start flag), or
  // "appearance" if the log carries no flag. Labels follow it.
  let unit = "start";
  let leftOut = [];
  const Us = () => `${unit}s`;
  let props = [];      // every posted prop for this pitcher
  let stats = null;
  let hand = null;
  let slate = null;
  const cleanups = [];

  document.title = `${ctx.name} | PWR Props`;
  let oppAbbr = abbr(ctx.opponent) || "OPP";
  const [firstName, lastName] = splitName(ctx.name);

  // Top of the report, PWR Lab direction: the athlete (real MLB imagery only),
  // the ticket (prop, line, both prices), then the result sitting on a bracket
  // that spans exactly the starts behind it.
  root.innerHTML = `
    <div class="page detail">
      <section class="lab" aria-labelledby="p-name">
        <div class="lab-photo" aria-hidden="true">
          <div class="lab-atmos" id="lab-atmos"></div>
          <div class="lab-cut" id="tk-face"><span class="face-init">${esc(initialsFor(ctx.name))}</span></div>
        </div>
        <nav class="crumbs" aria-label="Breadcrumb">
          <a class="btn btn-ghost back" href="${esc(boardHref())}" data-link>${icon("arrow-left")}Pitcher props</a>
          <span class="crumbs-sep" aria-hidden="true">/</span>
          <span class="crumbs-here" aria-current="page">${esc(ctx.name)}</span>
          <span class="spacer"></span>
          <button class="btn btn-ghost" type="button" id="share">${icon("link-simple")}<span>Copy link</span></button>
        </nav>
        <div class="lab-id">
          <h1 class="lab-name" id="p-name" style="--len:${Math.max(4, lastName.length)}">${firstName ? `<span class="lab-first">${esc(firstName)}</span> ` : ""}<span class="lab-last">${esc(lastName)}</span></h1>
          <p class="lab-meta" id="tk-game">${gameMeta()}</p>
        </div>
        <div class="lab-mkt">
          <div class="stat-tabs" role="tablist" aria-label="Prop" id="stat-tabs"></div>
          <div class="mk" id="tk-prop"></div>
        </div>
      </section>

      <div class="dgrid">
        <section class="sig" aria-labelledby="chart-title">
          <div class="sig-bar">
            <h2 class="sig-h" id="chart-title">Hit rate</h2>
            <div class="samples" role="radiogroup" aria-label="Sample" id="samples"></div>
            <div class="seg seg-sm" role="radiogroup" aria-label="Game log view" id="gl-view">
              <button type="button" role="radio" aria-checked="true" data-v="chart">Chart</button>
              <button type="button" role="radio" aria-checked="false" data-v="table">Table</button>
            </div>
          </div>
          <div class="rd" id="tk-hero" aria-live="polite"><span class="skeleton" style="display:block;height:96px"></span></div>
          <div id="gl-host"><div class="skeleton" style="height:260px"></div></div>
          <div class="gl-legend" id="gl-legend"></div>
          <dl class="per-start" id="per-start"></dl>
        </section>

        <aside class="rail" aria-label="Game context">
          <div class="rail-in">
            <h2 class="rail-h">Quick read</h2>
            <nav class="toc" aria-label="Report sections" id="toc">
              ${SECTIONS.map(([id, label]) => `<a href="#sec-${id}" data-toc="${id}"><span class="toc-l">${label}</span><span class="toc-f" id="toc-${id}"></span></a>`).join("")}
            </nav>
            <div class="ctx-group">
            <section class="ctx" aria-labelledby="ctx-game-h">
              <h2 class="ctx-h" id="ctx-game-h">Game</h2>
              <div id="ctx-game" class="ctx-body"><span class="skeleton" style="display:block;height:48px"></span></div>
            </section>
            <section class="ctx" aria-labelledby="ctx-wx-h">
              <h2 class="ctx-h" id="ctx-wx-h">Weather</h2>
              <div id="ctx-wx" class="ctx-body"><span class="skeleton" style="display:block;height:64px"></span></div>
            </section>
            <section class="ctx" aria-labelledby="ctx-park-h">
              <h2 class="ctx-h" id="ctx-park-h">Park factors</h2>
              <div id="ctx-park" class="ctx-body"><span class="skeleton" style="display:block;height:88px"></span></div>
            </section>
            </div>
          </div>
        </aside>

        <div class="report">
          ${section("lineup", "Opponent", `${esc(oppAbbr)} lineup`, "The hitters he faces, with each one's history against him.", true)}
          ${section("pitches", "Matchup", "Pitch matchup", `What he throws against what ${esc(oppAbbr)} hitters miss.`)}
          ${section("arsenal", "The pitcher", "Arsenal", "What he throws, how often, and which pitches miss bats.")}
          ${section("samehand", "Historical evidence", "Same-handed starters", `How starters of his hand have done against ${esc(oppAbbr)}.`)}
          ${section("splits", "Opponent profile", `${esc(oppAbbr)} team splits`, `What the ${esc(oppAbbr)} offense does well and poorly, pitch type by pitch type.`)}
          ${section("season", "Gradecard", "Season profile", "His 2026 rates against MLB average, from the pitcher's side.")}
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);

  // Each report section is a chapter of the dossier: kicker, title and one
  // computed finding, then a body with its own grammar. On phones the body
  // collapses behind the finding, so a closed chapter still says why to open it.
  function section(id, kicker, title, sub, open = false) {
    return `
      <section class="ch ch-${id}${open ? " open" : ""}" id="sec-${id}" aria-labelledby="sec-${id}-h">
        <header class="ch-head">
          <p class="ch-kick"><span class="ch-no">${String(SECTIONS.findIndex(([s]) => s === id) + 1).padStart(2, "0")}</span>${kicker}</p>
          <h2 class="ch-title" id="sec-${id}-h">${title}</h2>
          <p class="fact" id="fact-${id}"><span class="skeleton" style="display:inline-block;width:60%;height:18px"></span></p>
          <p class="ch-sub">${sub}</p>
          <button class="ch-toggle" type="button" aria-expanded="${open}" aria-controls="body-${id}"><span class="sr-only">${title}: show or hide the details</span>${icon("caret-down")}</button>
        </header>
        <div class="ch-body" id="body-${id}"><div class="skeleton" style="height:120px"></div></div>
      </section>`;
  }

  function slateGame() {
    return slate?.games.find((x) => x.home_team === ctx.home_team && (!ctx.game_time || Math.abs(new Date(x.game_time) - new Date(ctx.game_time)) < 12 * 3600_000)) || null;
  }

  // Matchup first and loudest, then hand, first pitch and park.
  function gameMeta() {
    const parts = [];
    if (ctx.team && ctx.opponent) {
      parts.push(`<span class="lab-mu"><b>${esc(abbr(ctx.team))}</b><span>${ctx.team === ctx.home_team ? "vs" : "at"}</span><b>${esc(abbr(ctx.opponent))}</b></span>`);
    } else if (ctx.matchup) parts.push(`<span class="lab-mu">${esc(ctx.matchup)}</span>`);
    if (hand) parts.push(`<span>${hand === "L" ? "LHP" : "RHP"}</span>`);
    if (ctx.game_time) parts.push(`<span>${esc(`${relDay(ctx.game_time)} ${time(ctx.game_time)}`)}</span>`);
    const v = slateGame()?.venue;
    if (v) parts.push(`<span class="lab-venue">${esc(v)}</span>`);
    return parts.join("");
  }
  const paintGame = () => { $("#tk-game").innerHTML = gameMeta(); };

  // Real MLB imagery only: his cutout (falling back to his headshot, then to
  // his initials) in front of his own action photo, left out if he has none.
  function paintPortrait() {
    const id = ctx.player_id;
    const face = $("#tk-face");
    const cut = new Image();
    cut.alt = ""; cut.decoding = "async"; cut.className = "cut-img";
    cut.addEventListener("load", () => cut.classList.add("on"));
    cut.addEventListener("error", () => {
      if (cut.dataset.fb) { cut.remove(); return; }
      cut.dataset.fb = "1"; face.classList.add("flat"); cut.src = headshot(id, 480);
    });
    cut.src = playerCutout(id, 720);
    face.append(cut);
    const at = $("#lab-atmos");
    const act = new Image();
    act.alt = ""; act.decoding = "async";
    act.srcset = `${playerAction(id, 900)} 900w, ${playerAction(id, 1800)} 1800w`;
    act.sizes = "(max-width: 767px) 100vw, 50vw";
    act.addEventListener("load", () => at.classList.add("on"));
    act.addEventListener("error", () => act.remove());
    at.append(act);
  }

  // ---------- URL sync ----------
  const sync = () => setQuery((p) => {
    p.set("pitcher", ctx.name);
    ctx.line != null ? p.set("line", String(ctx.line)) : p.delete("line");
    ctx.selection ? p.set("selection", ctx.selection) : p.delete("selection");
    p.set("statKey", ctx.statKey);
    ctx.sample !== "L10" ? p.set("sample", ctx.sample) : p.delete("sample");
    if (ctx.line != null) p.set("market", `${marketLabel(STATKEY_TO_MARKET[ctx.statKey])} · ${ctx.selection} ${fmtLine(ctx.line)}`);
    else p.delete("market");
  });

  // ---------- Ticket: stat tabs, prop, samples ----------
  const statLabel = () => STATS.find((s) => s.key === ctx.statKey)?.label || "Strikeouts";
  const statShort = () => STATS.find((s) => s.key === ctx.statKey)?.short || "K";
  const marketProps = () => props.filter((p) => p.market_type === STATKEY_TO_MARKET[ctx.statKey] || MARKET_TO_STATKEY[p.market_type] === ctx.statKey);

  function paintStatTabs() {
    $("#stat-tabs").innerHTML = STATS.map((s) => {
      const posted = props.filter((p) => MARKET_TO_STATKEY[p.market_type] === s.key);
      const main = posted.find(isMainLine) || posted[0];
      const sel = s.key === ctx.statKey;
      return `<button type="button" role="tab" aria-selected="${sel}" data-stat="${s.key}" tabindex="${sel ? 0 : -1}" title="${s.label}${main ? `, line ${fmtLine(main.line)}` : ", no line posted"}">${s.short}${main ? `<span class="seg-meta">${fmtLine(main.line)}</span>` : `<span class="seg-meta seg-text">no line</span>`}</button>`;
    }).join("");
  }

  // One side of the ticket at the current line: best price, its book, the rest.
  function sideQuote(side) {
    const p = marketProps().find((x) => Number(x.line) === ctx.line && x.selection === side);
    if (!p) return null;
    const best = bestOdds(p);
    const book = p.books.find((b) => b.odds_american === best);
    return { best, book, others: p.books.filter((b) => b !== book), n: p.books.length };
  }

  // The ticket: prop, the line as the object, then both sides read like a
  // sportsbook (side, price, book). Each side row is also the side selector.
  function paintProp() {
    const el = $("#tk-prop");
    const lines = [...new Set(marketProps().map((p) => Number(p.line)))].sort((a, b) => a - b);
    if (ctx.line == null) {
      el.innerHTML = `
        <div class="mk-head"><span class="mk-stat">${esc(statLabel())}</span></div>
        <p class="mk-none">No line posted${props.length ? " for this stat" : ""}</p>
        <p class="mk-note">Showing his results without a line, so no start is marked as a hit or a miss.</p>`;
      return;
    }
    const row = (side) => {
      const q = sideQuote(side);
      const imp = q ? implied(q.best) : null;
      return `<button type="button" role="radio" class="mk-row" aria-checked="${ctx.selection === side}" data-side="${side}" ${q ? "" : "disabled"}>
        <span class="mk-side">${side}</span>
        ${q ? `<span class="mk-odds num">${fmtOdds(q.best)}</span>
          <span class="mk-book"><b>${esc(bookName(q.book?.sportsbook))}</b><small>${q.n > 1 ? `Best of ${q.n}` : "One book"}${q.others.length ? `, ${q.others.map((b) => `${esc(bookLabel(b.sportsbook))} ${fmtOdds(b.odds_american)}`).join(", ")}` : ""}</small></span>
          <span class="mk-imp"><b class="num">${imp != null ? imp.toFixed(1) + "%" : "-"}</b><small>implied</small></span>`
        : `<span class="mk-off">No ${side.toLowerCase()} price at ${esc(fmtLine(ctx.line))}</span>`}
      </button>`;
    };
    el.innerHTML = `
      <div class="mk-head"><span class="mk-stat">${esc(statLabel())}</span>${lines.length > 1 ? `<span class="mk-count">${lines.length} lines posted</span>` : ""}</div>
      <button class="mk-line line-btn" type="button" id="line-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Line ${esc(fmtLine(ctx.line))}${lines.length > 1 ? `, ${lines.length} lines posted. Choose a line` : ""}" ${lines.length > 1 ? "" : 'aria-disabled="true"'}>
        <span class="mk-num">${esc(fmtLine(ctx.line))}</span>${lines.length > 1 ? `<span class="mk-alt">Line${icon("caret-down")}</span>` : ""}
      </button>
      <div class="mk-rows" role="radiogroup" aria-label="Side">${row("Over")}${row("Under")}</div>
      <div class="popover line-pop" id="line-pop" role="listbox" aria-label="Choose a line" hidden>
        ${lines.map((l) => {
          const o = marketProps().find((p) => Number(p.line) === l && p.selection === "Over");
          const u = marketProps().find((p) => Number(p.line) === l && p.selection === "Under");
          const opt = (p, s) => p
            ? `<button type="button" role="option" class="lp-opt" aria-selected="${l === ctx.line && ctx.selection === s}" data-line="${l}" data-sel="${s}"><span>${s === "Over" ? "O" : "U"} <span class="num">${fmtLine(l)}</span></span><span class="num">${fmtOdds(bestOdds(p))}</span></button>`
            : `<span class="lp-opt lp-off" aria-hidden="true">${s === "Over" ? "O" : "U"} ${fmtLine(l)}</span>`;
          return `<div class="lp-row">${opt(o, "Over")}${opt(u, "Under")}</div>`;
        }).join("")}
      </div>`;
  }

  // Won-lost against the line, the scoreboard way. A whole-number line can push:
  // the push is shown on its own, and (as before) never counts as a hit.
  function record(r) {
    const push = Number.isInteger(ctx.line) ? r.values.filter((v) => v === ctx.line).length : 0;
    return `${r.hits}–${r.n - r.hits - push}${push ? `–${push}` : ""}`;
  }

  function paintSamples() {
    const stat = ctx.statKey;
    $("#samples").innerHTML = SAMPLES.map((s) => {
      const g = gamesForSample(games, s.key, ctx.opponent);
      const r = hitRate(g, stat, ctx.line, ctx.selection || "Over");
      const on = ctx.sample === s.key;
      const big = !r.n ? "-" : ctx.line == null ? r.mean.toFixed(1) : `${r.pct}%`;
      const meta = !r.n ? "none" : ctx.line == null ? `avg, ${r.n}` : record(r);
      const label = `${s.label}${s.key === "H2H" ? ` vs ${oppAbbr}` : ""}: ${!r.n ? `no ${Us()}` : ctx.line == null ? `average ${r.mean.toFixed(1)} over ${r.n} ${Us()}` : `${r.pct}%, ${r.hits} of ${r.n}`}`;
      return `<button type="button" role="radio" aria-checked="${on}" data-sample="${s.key}" tabindex="${on ? 0 : -1}" aria-label="${esc(label)}">
        <span class="smp-l">${s.label}${s.key === "H2H" ? `<span class="smp-opp"> ${esc(oppAbbr)}</span>` : ""}</span>
        <span class="smp-v">${big}</span>
        <span class="smp-meta num">${meta}</span>
      </button>`;
    }).join("");
  }

  // The result for the selected sample: rate, record and one plain sentence,
  // set on the bracket that spans the starts behind it.
  function paintHero() {
    const el = $("#tk-hero");
    const g = gamesForSample(games, ctx.sample, ctx.opponent);
    const r = hitRate(g, ctx.statKey, ctx.line, ctx.selection || "Over");
    const sampleLabel = SAMPLES.find((s) => s.key === ctx.sample).label;
    if (!g.length || !r.n) {
      el.innerHTML = `<p class="rd-verdict rd-empty">${!g.length ? (ctx.sample === "H2H" ? `No ${Us()} against ${esc(ctx.opponent || "this opponent")} this season.` : `No ${Us()} in this sample.`) : `No recorded ${esc(statLabel().toLowerCase())} in these ${Us()}.`}</p>`;
      return;
    }
    const gap = r.missing ? `<p class="rd-gap">${r.missing} ${r.missing === 1 ? `${unit} has` : `${Us()} have`} no recorded value and ${r.missing === 1 ? "is" : "are"} left out.</p>` : "";
    const stat = esc(statLabel().toLowerCase());
    if (ctx.line == null) {
      const psN = postseasonCount(g);
      const scope = (ctx.sample === "season" ? "this season" : ctx.sample === "H2H" ? `against ${esc(oppAbbr)} this season` : `in his last ${g.length} ${Us()}`) + (psN ? `, ${psN} in the postseason` : "");
      el.innerHTML = `
        <div class="rd-nums"><div class="rd-pct"><span class="rd-pct-v">${r.mean.toFixed(1)}</span><span class="rd-cap">${esc(statShort())} per start, ${esc(sampleLabel)}</span></div></div>
        <div class="rd-text"><p class="rd-verdict">He has averaged <b>${r.mean.toFixed(1)}</b> ${stat} ${scope}. Median <b>${r.med}</b>.</p>${gap}</div>`;
      return;
    }
    const all = r.n === g.length;
    // Postseason starts count in every sample; the sentence says how many are in this one.
    const ps = postseasonCount(g);
    const psNote = ps ? ` (${ps} in the postseason)` : "";
    const subject = ctx.sample === "season"
      ? (all ? `${r.hits} of his ${r.n} ${Us()} this season` : `${r.hits} of ${r.n} recorded ${Us()} this season`)
      : ctx.sample === "H2H"
        ? `${r.hits} of ${r.n} ${Us()} against ${oppAbbr} this season`
        : (all ? `${r.hits} of his last ${r.n} ${Us()}` : `${r.hits} of ${r.n} recorded ${Us()} in his last ${g.length}`);
    const tone = r.pct >= 55 ? "good" : r.pct < 45 ? "bad" : "";
    const side = ctx.selection === "Under" ? "Under" : "Over";
    const ln = esc(fmtLine(ctx.line));
    el.innerHTML = `
      <div class="rd-nums">
        <div class="rd-pct ${tone}"><span class="rd-pct-v">${r.pct}<small>%</small></span><span class="rd-cap">${esc(sampleLabel === "H2H" ? `vs ${oppAbbr}` : sampleLabel)} hit rate</span></div>
        <div class="rd-rec"><span class="rd-rec-v">${record(r)}</span><span class="rd-cap">${side} ${ln} record</span></div>
      </div>
      <div class="rd-text">
        <p class="rd-verdict"><b>${esc(subject)}</b>${psNote} went ${side.toLowerCase()} ${ln} ${stat}. Average <b>${r.mean.toFixed(1)}</b>, median <b>${r.med}</b>.</p>
        ${gap}
      </div>`;
  }

  function paintPerStart() {
    const g = gamesForSample(games, ctx.sample, ctx.opponent);
    const a = sampleAverages(g, avg);
    const cell = (label, v, title) => `<div title="${title}"><dt>${label}</dt><dd class="num">${v ?? "-"}</dd></div>`;
    $("#per-start").innerHTML = g.length
      ? cell("IP", a.ip, `Innings per ${unit}`) + cell("Pitches", a.pitches?.toFixed(1), `Pitches per ${unit}`) + cell("Batters faced", a.bf?.toFixed(1), `Batters faced per ${unit}`) +
        cell("Called strikes", a.called?.toFixed(1), `Called strikes per ${unit} (last ~45 days of pitch data)`) + cell("Swinging strikes", a.swinging?.toFixed(1), `Swinging strikes per ${unit} (last ~45 days of pitch data)`) + cell("CSW%", a.csw != null ? a.csw.toFixed(1) + "%" : null, "Called plus swinging strikes per pitch")
      : "";
  }

  // The chart always draws the whole season; the sample decides which starts
  // are lit and where the bracket runs.
  let chart = null;
  function paintChart() {
    const g = gamesForSample(games, ctx.sample, ctx.opponent);
    const inSample = new Set(g);
    const sampleLabel = SAMPLES.find((s) => s.key === ctx.sample).label;
    $("#chart-title").textContent = `${statLabel()} by ${unit}`;
    chart?.update({
      games, lit: games.map((x) => inSample.has(x)),
      statKey: ctx.statKey, statLabel: statLabel(), statShort: statShort(), line: ctx.line, selection: ctx.selection || "Over",
      sampleText: ctx.sample === "season" ? `every ${unit}` : ctx.sample === "H2H" ? `${Us()} against ${oppAbbr}` : `his last ${g.length} ${Us()}`,
      emptyText: `No ${Us()} recorded this season.`, unit,
    });
    const context = ctx.sample === "season" ? "" : `<span class="lg"><i class="lg-b"></i>${esc(sampleLabel === "H2H" ? `Starts vs ${oppAbbr}` : sampleLabel)}</span><span class="lg"><i class="lg-d"></i>Rest of season, dimmed</span>`;
    $("#gl-legend").innerHTML = (ctx.line == null
      ? `<span class="lg"><i class="lg-n"></i>${esc(statLabel())} per start</span>`
      : `<span class="lg"><i class="lg-h"></i>Went ${esc(ctx.selection.toLowerCase())} ${esc(fmtLine(ctx.line))}</span><span class="lg"><i class="lg-m"></i>Did not</span><span class="lg"><i class="lg-l"></i>Line ${esc(fmtLine(ctx.line))}</span>`) + context + leftOutNote();
  }

  function leftOutNote() {
    if (unit !== "start") return `<span class="lg lg-note">No start flag in this game log: every appearance is counted.</span>`;
    if (!leftOut.length) return "";
    const relief = leftOut.filter((g) => g.started === false);
    const unknown = leftOut.length - relief.length;
    const dates = relief.map((g) => dateShort(g.date)).join(", ");
    return `<span class="lg lg-note">${relief.length ? `Not counted: ${relief.length} relief ${relief.length === 1 ? "appearance" : "appearances"} (${esc(dates)})` : ""}${relief.length && unknown ? "; " : relief.length ? "" : "Not counted: "}${unknown ? `${unknown} with no start flag` : ""}.</span>`;
  }

  function paintTicket() {
    paintStatTabs(); paintProp(); paintSamples(); paintHero(); paintChart(); paintPerStart();
    // The lineup meter and the evidence ledger follow the prop's stat and line.
    if (oppData.batters) paintLineup();
    if (starters.length) paintSameHanded();
  }

  // ---------- Ticket events ----------
  $("#stat-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-stat]");
    if (!b || b.dataset.stat === ctx.statKey) return;
    ctx.statKey = b.dataset.stat;
    // The line belongs to the prop that was opened. A different stat needs
    // that stat's own posted line (main line first, same side if it exists).
    const pool = marketProps();
    if (!pool.length) { ctx.line = null; }
    else {
      const mains = pool.filter(isMainLine);
      const src = mains.length ? mains : pool;
      const chosen = src.find((p) => p.selection === ctx.selection) || src[0];
      ctx.line = Number(chosen.line); ctx.selection = chosen.selection;
    }
    sync(); paintTicket();
    $(`#stat-tabs [data-stat="${ctx.statKey}"]`)?.focus();
  });
  $("#stat-tabs").addEventListener("keydown", (e) => arrowNav(e, "#stat-tabs [data-stat]"));
  $("#samples").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sample]");
    if (!b) return;
    ctx.sample = b.dataset.sample;
    sync(); paintSamples(); paintHero(); paintChart(); paintPerStart();
    $(`#samples [data-sample="${ctx.sample}"]`)?.focus();
  });
  $("#samples").addEventListener("keydown", (e) => arrowNav(e, "#samples [data-sample]"));
  $("#gl-view").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    root.querySelectorAll("#gl-view button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    chart?.setView(b.dataset.v);
  });
  $("#tk-prop").addEventListener("click", (e) => {
    const side = e.target.closest("[data-side]");
    if (side && !side.disabled) { ctx.selection = side.dataset.side; sync(); paintTicket(); return; }
    const lb = e.target.closest("#line-btn");
    const pop = $("#line-pop");
    if (lb && lb.getAttribute("aria-disabled") !== "true") {
      const open = pop.hidden;
      pop.hidden = !open; lb.setAttribute("aria-expanded", String(open));
      if (open) {
        const r = lb.getBoundingClientRect();
        pop.style.top = `${r.bottom + 6}px`;
        pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12))}px`;
        pop.querySelector('[aria-selected="true"]')?.focus();
      }
      return;
    }
    const opt = e.target.closest(".lp-opt[data-line]");
    if (opt) { ctx.line = Number(opt.dataset.line); ctx.selection = opt.dataset.sel; sync(); paintTicket(); $("#line-btn")?.focus(); }
  });
  const closeLinePop = (e) => {
    const pop = root.querySelector("#line-pop");
    if (pop && !pop.hidden && !pop.contains(e.target) && !e.target.closest("#line-btn")) { pop.hidden = true; root.querySelector("#line-btn")?.setAttribute("aria-expanded", "false"); }
  };
  const escLinePop = (e) => { if (e.key === "Escape") closeLinePop({ target: document.body }); };
  document.addEventListener("click", closeLinePop);
  document.addEventListener("keydown", escLinePop);
  window.addEventListener("scroll", closeLinePop, { passive: true });
  cleanups.push(() => { document.removeEventListener("click", closeLinePop); document.removeEventListener("keydown", escLinePop); window.removeEventListener("scroll", closeLinePop); });

  $("#share").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(window.location.href);
      btn.querySelector("span").textContent = "Link copied";
      setTimeout(() => { if (btn.isConnected) btn.querySelector("span").textContent = "Copy link"; }, 1800);
    } catch { window.prompt("Copy this link:", window.location.href); }
  });

  function arrowNav(e, sel) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const btns = [...root.querySelectorAll(sel)].filter((b) => !b.disabled);
    const i = btns.indexOf(document.activeElement);
    let n = e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : i + (e.key === "ArrowRight" ? 1 : -1);
    n = (n + btns.length) % btns.length;
    e.preventDefault(); btns[n].click();
  }

  // ---------- Report: TOC scrollspy ----------
  const spy = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      const id = en.target.id.replace("sec-", "");
      root.querySelectorAll("[data-toc]").forEach((a) => a.toggleAttribute("aria-current", a.dataset.toc === id));
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  root.querySelectorAll(".ch").forEach((s) => spy.observe(s));
  cleanups.push(() => spy.disconnect());

  // Phones: a chapter opens and closes from its header, and the quick-read
  // index opens the chapter it jumps to.
  const openChapter = (ch, open) => {
    ch.classList.toggle("open", open);
    ch.querySelector(".ch-toggle")?.setAttribute("aria-expanded", String(open));
  };
  $(".report").addEventListener("click", (e) => {
    const t = e.target.closest(".ch-toggle");
    if (t) openChapter(t.closest(".ch"), !t.closest(".ch").classList.contains("open"));
  });
  // The index jumps within the page itself: the app router would otherwise
  // treat "#sec-..." as a navigation and re-render the report.
  $("#toc").addEventListener("click", (e) => {
    const a = e.target.closest("[data-toc]");
    const ch = a && $(`#sec-${a.dataset.toc}`);
    if (!ch) return;
    e.preventDefault();
    openChapter(ch, true);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ch.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    const h = ch.querySelector(".ch-title");
    h.setAttribute("tabindex", "-1");
    h.focus({ preventScroll: true });
  });

  // ---------- Loading ----------
  const setFact = (id, html) => { const el = $(`#fact-${id}`); if (el) el.innerHTML = html; };
  // The report index doubles as a quick read: each entry carries its section's headline number.
  const toc = (id, text) => { const el = $(`#toc-${id}`); if (el) el.textContent = text; };
  const setBody = (id, html) => { const el = $(`#body-${id}`); if (el) el.innerHTML = html; };
  const fail = (id, what) => { setFact(id, `<span class="faint">Unavailable</span>`); setBody(id, `<div class="state-inline">Couldn't load ${what}. Refresh the page to try again.</div>`); };

  async function boot() {
    // The readout sits on the bracket: the chart reports where the bracket ends.
    chart = mountGameLog($("#gl-host"), { onLayout: ({ inset }) => $("#tk-hero")?.style.setProperty("--inset", `${Math.round(inset)}px`) });
    cleanups.push(() => chart.destroy());

    const [pitcherRes, slateRes] = await Promise.allSettled([api.pitcher(ctx.name), loadSlate()]);
    if (!alive) return;
    if (slateRes.status === "fulfilled") {
      slate = slateRes.value;
      const key = nameKey(ctx.name);
      props = slate.props.filter((p) => nameKey(p.player_name) === key);
      const sched = scheduleFor(slate.schedule, ctx.name);
      if (sched) {
        ctx.opponent ||= sched.opponent; ctx.home_team ||= sched.home_team; ctx.game_time ||= sched.game_time; ctx.team ||= sched.team;
      }
      // Not in MLB's probables yet: take the side the board resolved from the feed (never guessed).
      const placed = groupRows(props, slate.schedule).find((r) => r.team);
      if (placed) {
        ctx.team ||= placed.team; ctx.opponent ||= placed.opponent; ctx.home_team ||= placed.home_team; ctx.game_time ||= placed.game_time;
      }
      // Opened without a prop (for example from Lineup matchups): use the posted main line if one exists.
      if (ctx.line == null && props.length) {
        const pool = marketProps();
        const main = pool.find(isMainLine) || pool[0];
        if (main) { ctx.line = Number(main.line); ctx.selection = main.selection === "Under" ? "Under" : "Over"; }
      }
      paintGame();
      // Opened from a bare ?pitcher= link: the opponent is only known now, so
      // the labels drawn with the placeholder are brought up to date.
      if (oppAbbr === "OPP" && ctx.opponent) {
        oppAbbr = abbr(ctx.opponent);
        $("#sec-lineup-h").textContent = `${oppAbbr} lineup`;
        $("#sec-splits-h").textContent = `${oppAbbr} team splits`;
        $("#sec-pitches .ch-sub").textContent = `What he throws against what ${oppAbbr} hitters miss.`;
        $("#sec-samehand .ch-sub").textContent = `How starters of his hand have done against ${oppAbbr}.`;
        $("#sec-splits .ch-sub").textContent = `What the ${oppAbbr} offense does well and poorly, pitch type by pitch type.`;
      }
    }
    paintStatTabs(); paintProp();

    if (pitcherRes.status !== "fulfilled" || !pitcherRes.value.matched || !pitcherRes.value.stats) {
      $("#gl-host").innerHTML = `<div class="state"><strong>No stats found for ${esc(ctx.name)} yet.</strong><span>Stats refresh twice a day from Baseball Savant. Recent call-ups can take a day to appear.</span></div>`;
      $("#samples").innerHTML = ""; $("#tk-hero").innerHTML = "";
      ["lineup", "pitches", "arsenal", "samehand", "splits", "season"].forEach((id) => fail(id, "this section"));
      loadEnvironment();
      return;
    }
    stats = pitcherRes.value.stats;
    ctx.player_id = stats.player_id;
    paintPortrait();

    loadGameLog();
    loadEnvironment();
    loadHand().then(() => loadSameHanded());
    loadOpponent();
    loadArsenal();
    paintSeason();
  }

  async function loadGameLog() {
    try {
      const [gl, pm] = await Promise.all([
        api.gamelog(ctx.player_id),
        api.pitchMetrics(ctx.player_id).catch(() => ({ games: [] })),
      ]);
      if (!alive) return;
      const byDate = new Map((pm.games || []).map((g) => [g.date, g]));
      const all = (gl.games || []).map((g) => {
        const m = byDate.get(g.date);
        return { ...g, called_strikes: m ? m.called_strikes : null, swinging_strikes: m ? m.swinging_strikes : null, csw_pct: m ? m.csw_pct : null };
      });
      // "Starts" means real starts, by MLB's own gamesStarted flag. Relief
      // outings are left out and named under the chart. If a log carries no
      // flag at all, nothing is guessed: every appearance is shown and every
      // label says "appearances" instead.
      ({ games, unit, leftOut } = startsOf(all));
      paintTicket();
    } catch {
      if (!alive) return;
      $("#gl-host").innerHTML = `<div class="state" role="alert"><strong>Couldn't load his game log.</strong><span>The MLB game log request failed. Refresh to try again.</span></div>`;
    }
  }

  async function loadHand() {
    try {
      hand = (await api.pitcherHand(ctx.player_id)).hand || null;
      if (alive && hand) paintGame();
    } catch {}
  }

  // ----- Opponent: lineup, team splits, pitch matchup -----
  let teamSplitState = { split: "", view: "pd" };
  let oppData = {};
  async function loadOpponent() {
    if (!ctx.opponent) {
      ["lineup", "pitches", "splits"].forEach((id) => { setFact(id, `<span class="faint">Opponent unknown</span>`); setBody(id, `<div class="state-inline">This pitcher isn't matched to a scheduled game, so there's no opponent to show.</div>`); });
      return;
    }
    try {
      const [batters, splits, pitchSplits] = await Promise.all([
        api.teamBatters(ctx.opponent), api.teamSplits(ctx.opponent), api.teamPitchSplits(ctx.opponent),
      ]);
      if (!alive) return;
      oppData = { batters, splits, pitchSplits: pitchSplits.splits || [] };
      wireBvp($("#body-lineup"), ctx);
      paintLineup();
      paintPitchMatchup();
      paintTeamSplits();
    } catch {
      if (!alive) return;
      fail("lineup", "the opposing lineup"); fail("splits", "team splits"); fail("pitches", "the pitch matchup");
    }
  }

  function postedLineup() {
    const game = slate?.games.find((g) =>
      g.home_team === ctx.home_team && (g.away_team === ctx.opponent || g.home_team === ctx.opponent) &&
      (!ctx.game_time || Math.abs(new Date(g.game_time) - new Date(ctx.game_time)) < 12 * 3600_000));
    if (!game) return null;
    return game.home_team === ctx.opponent ? game.home_lineup : game.away_lineup;
  }

  // The finding: how many of these hitters are above the MLB reference on the
  // stat the prop is about, and who leads. The posted/not-posted state leads,
  // so a collapsed chapter on a phone still says which list this is.
  function paintLineup() {
    const posted = postedLineup();
    const lineup = buildLineup(oppData.batters, oppData.splits, posted);
    const s = productionSummary(oppData.batters);
    toc("lineup", `${lineup.confirmed ? "Posted" : "Not posted"}, team K ${s.k != null ? s.k.toFixed(1) + "%" : "-"}`);
    const [mk, phrase, ref, isPct] = {
      walks: ["bb_pct", "walk more than", LEAGUE_AVG.bb_pct, true],
      hits_allowed: ["ba", "hit above", LEAGUE_AVG.ba, false],
      earned_runs: ["ba", "hit above", LEAGUE_AVG.ba, false],
    }[ctx.statKey] || ["k_pct", "strike out more than", LEAGUE_AVG.k_pct, true];
    const f = (v) => (isPct ? `${v.toFixed(1)}%` : avg3(v));
    const known = lineup.batters.filter((b) => b[mk] != null);
    const above = known.filter((b) => b[mk] > ref);
    const lead = [...known].sort((a, b) => b[mk] - a[mk])[0];
    const group = lineup.confirmed ? "In the posted order" : `Among the nine ${esc(oppAbbr)} hitters with the most plate appearances`;
    setFact("lineup", known.length
      ? `<span><b>${lineup.confirmed ? "Batting order posted." : "Lineup not posted yet."}</b> ${group}, <b class="num">${above.length}</b> of ${known.length} ${phrase} the <b class="num">${f(ref)}</b> MLB average${lead ? `, led by <b>${esc(lead.name)}</b> at <b class="num">${f(lead[mk])}</b>` : ""}.</span>`
      : `<span><b>${lineup.confirmed ? "Batting order posted." : "Lineup not posted yet."}</b></span>`);
    setBody("lineup", lineupCard(lineup, { oppAbbr, pitcherName: ctx.name, statKey: ctx.statKey, summary: s }));
  }

  function paintPitchMatchup() {
    const ars = stats?.arsenal || [];
    const byType = new Map((oppData.pitchSplits || []).map((s) => [s.pitch_type, s]));
    const joined = ars.filter((p) => (p.usage_pct || 0) >= 5 && p.whiff_pct != null && byType.get(p.pitch_type)?.whiff_pct != null);
    if (joined.length) {
      const best = [...joined].sort((a, b) => byType.get(b.pitch_type).whiff_pct - byType.get(a.pitch_type).whiff_pct)[0];
      const o = byType.get(best.pitch_type);
      toc("pitches", `${shortPitch(best)}: ${oppAbbr} whiff ${o.whiff_pct.toFixed(1)}%`);
      setFact("pitches", `<span>${esc(oppAbbr)} hitters whiff most against the <b>${esc(best.pitch_name || best.pitch_type)}</b> (<b class="num">${o.whiff_pct.toFixed(1)}%</b>), a pitch he throws <b class="num">${best.usage_pct.toFixed(1)}%</b> of the time with a <b class="num">${best.whiff_pct.toFixed(1)}%</b> whiff rate.</span>`);
    } else setFact("pitches", `<span class="faint">Not enough overlapping pitch data to compare.</span>`);
    setBody("pitches", pitchDuel(ars, oppData.pitchSplits, { oppAbbr, lastName }));
  }

  // Opponent profile first (what they do well and poorly), then the full
  // split tables behind a disclosure, with their own toggles.
  let profile = null, profileRO = null, profileW = 0;
  cleanups.push(() => profileRO?.disconnect());
  function paintTeamSplits() {
    profile = opponentModel(oppData.pitchSplits, { summary: productionSummary(oppData.batters), arsenal: stats?.arsenal, oppAbbr });
    toc("splits", profile ? `Misses most: ${shortPitch(profile.struggle)}` : "No data");
    setFact("splits", profile ? `<span>${opponentFact(profile)}</span>` : `<span class="faint">Not enough pitch-type results to profile this offense.</span>`);
    setBody("splits", `${opponentProfile(profile)}
      <details class="disclose" id="ts-detail">
        <summary>${icon("caret-right")}Plate discipline, batted ball and production by pitch type</summary>
        <div class="disclose-body" id="ts-wrap"></div>
      </details>`);
    const plot = $("#body-splits .op-plot");
    profileRO?.disconnect();
    if (plot && profile) {
      profileW = 0;
      profileRO = new ResizeObserver(() => {
        if (plot.clientWidth === profileW) return;
        profileW = plot.clientWidth;
        drawProfilePlot(plot, profile);
      });
      profileRO.observe(plot);
    }
    paintSplitDetail();
  }
  function paintSplitDetail() {
    const wrap = $("#ts-wrap");
    if (!wrap) return;
    const splitBtns = [["", "Overall"], ["R", "vs RHP"], ["L", "vs LHP"], ["pitcher", `vs ${lastName}`]];
    const viewBtns = [["pd", "Plate discipline"], ["bb", "Batted ball"], ["prod", "Production"]];
    const d = oppData.splits;
    const pts = d?.pitch_types || [];
    const swstr = weightedAvg(pts, (p) => p.plate_discipline?.swstr_pct, (p) => p.pitches);
    const win = d?.window === "last_240_days" ? "last 240 days" : "last 60 days";
    const splitLabel = splitBtns.find(([v]) => v === teamSplitState.split)[1];
    // How this lineup handles the pitch he throws most, against its own all-pitch rate.
    const chase = weightedAvg(pts, (p) => p.plate_discipline?.o_swing_pct, (p) => p.pitches);
    const top = (stats?.arsenal || [])[0];
    const vsTop = top ? pts.find((p) => p.pitch_type === top.pitch_type) : null;
    let fact;
    if (teamSplitState.view === "prod") {
      const row = top ? (oppData.pitchSplits || []).find((s) => s.pitch_type === top.pitch_type) : null;
      fact = row && row.est_ba != null
        ? `${esc(oppAbbr)} hitters have a <b class="num">${avg3(row.est_ba)}</b> xBA and <b class="num">${row.k_pct != null ? row.k_pct.toFixed(1) + "%" : "-"}</b> K rate this season against ${esc(pitchPlural(top))}, the pitch he throws most.`
        : `Season production by pitch type for the ${esc(oppAbbr)} roster.`;
    } else if (vsTop && vsTop.plate_discipline?.swstr_pct != null && swstr != null) {
      const pd = vsTop.plate_discipline;
      fact = `Against ${esc(pitchPlural(top))}, the pitch he throws most, ${esc(oppAbbr)} chases <b class="num">${pd.o_swing_pct != null ? pd.o_swing_pct.toFixed(1) + "%" : "-"}</b> and whiffs on <b class="num">${pd.swstr_pct.toFixed(1)}%</b> of pitches, versus <b class="num">${chase != null ? chase.toFixed(1) + "%" : "-"}</b> and <b class="num">${swstr.toFixed(1)}%</b> on everything (${esc(splitLabel === "Overall" ? "all pitchers" : splitLabel)}, ${win}).`;
    } else {
      fact = `${esc(splitLabel)}, ${win}: not enough pitch data to compare against his main pitch.`;
    }
    wrap.innerHTML = `
      <p class="ts-fact">${fact}</p>
      <div class="toolbar">
        <div class="seg seg-sm" role="radiogroup" aria-label="View">${viewBtns.map(([v, l]) => `<button type="button" role="radio" data-tsv="${v}" aria-checked="${teamSplitState.view === v}">${l}</button>`).join("")}</div>
        <div class="seg seg-sm" role="radiogroup" aria-label="Pitcher split" ${teamSplitState.view === "prod" ? "hidden" : ""}>${splitBtns.map(([v, l]) => `<button type="button" role="radio" data-tss="${v}" aria-checked="${teamSplitState.split === v}">${esc(l)}</button>`).join("")}</div>
      </div>
      ${teamSplitState.view === "prod" ? "" : `<p class="viz-note">${esc(splitLabel)}, ${win}, ${(d?.total_pitches_sampled ?? 0).toLocaleString()} pitches sampled.</p>`}
      <div id="ts-table">${teamSplitState.view === "prod" ? productionTable(oppData.pitchSplits) : teamSplitTable(d?.pitch_types, teamSplitState.view)}</div>`;
  }
  $("#body-splits").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-tsv]"), s = e.target.closest("[data-tss]");
    if (v) { teamSplitState.view = v.dataset.tsv; paintSplitDetail(); return; }
    if (!s) return;
    teamSplitState.split = s.dataset.tss;
    root.querySelectorAll("[data-tss]").forEach((b) => b.setAttribute("aria-checked", String(b === s)));
    $("#ts-table").classList.add("stale-dim");
    try {
      oppData.splits = teamSplitState.split === "pitcher"
        ? await api.teamSplits(ctx.opponent, { pitcherId: ctx.player_id })
        : await api.teamSplits(ctx.opponent, { hand: teamSplitState.split || undefined });
      if (alive) paintSplitDetail();
    } catch { if (alive) $("#ts-table").innerHTML = `<div class="state-inline">Couldn't load this split.</div>`; }
  });

  // ----- Arsenal -----
  let arsenalHand = "";
  let platoon = null;
  async function loadArsenal() {
    const ars = stats?.arsenal || [];
    const topWhiff = [...ars].filter((p) => p.whiff_pct != null && (p.usage_pct || 0) >= 5).sort((a, b) => b.whiff_pct - a.whiff_pct)[0];
    toc("arsenal", ars.length ? `${ars.length} pitches${topWhiff ? `, ${shortPitch(topWhiff)} ${topWhiff.whiff_pct.toFixed(1)}% whiff` : ""}` : "No data");
    const paint = () => {
      const openState = $("#pitch-detail")?.open;
      const pf = platoonFact(ars, platoon);
      setFact("arsenal", `<span>${esc(arsenalFact(ars))}${pf ? ` ${esc(pf)}` : ""}</span>`);
      setBody("arsenal", `
        ${arsenalSystem(ars, platoon)}
        <details class="disclose"><summary>${icon("caret-right")}Full arsenal table: usage, whiff, put-away, K%, BA, xBA and PA by pitch</summary><div class="disclose-body">${arsenalTable(ars, platoon)}</div></details>
        ${pitchDetailShell()}`);
      if (openState) { $("#pitch-detail").open = true; loadPitchDetail(); }
    };
    paint();
    try {
      const [L, R] = await Promise.all([api.pitcherSplits(ctx.player_id, "L"), api.pitcherSplits(ctx.player_id, "R")]);
      if (!alive) return;
      platoon = platoonUsage(L, R);
      paint();
    } catch {}
  }
  function pitchDetailShell() {
    return `
      <details class="disclose" id="pitch-detail">
        <summary>${icon("caret-right")}Pitch-level plate discipline and batted ball</summary>
        <div class="disclose-body">
          <div class="seg seg-sm" role="radiogroup" aria-label="Batter side">${[["", "All hitters"], ["R", "vs RHH"], ["L", "vs LHH"]].map(([v, l]) => `<button type="button" role="radio" data-ah="${v}" aria-checked="${arsenalHand === v}">${l}</button>`).join("")}</div>
          <div id="pd-tables"><div class="state-inline">Loading…</div></div>
        </div>
      </details>`;
  }
  async function loadPitchDetail() {
    const host = $("#pd-tables");
    if (!host) return;
    host.classList.add("stale-dim");
    try {
      const d = await api.pitcherSplits(ctx.player_id, arsenalHand || undefined);
      if (!alive || !host.isConnected) return;
      const pts = d.pitch_types || [];
      host.classList.remove("stale-dim");
      host.innerHTML = !pts.length ? `<div class="state-inline">No data for this split.</div>` : `
        <h3 class="h-sub sub-h">Plate discipline</h3>
        <div class="table-scroll"><table class="dt"><thead><tr><th scope="col">Pitch</th><th scope="col">Pitches</th><th scope="col">O-Swing%</th><th scope="col">Z-Swing%</th><th scope="col">Swing%</th><th scope="col">O-Contact%</th><th scope="col">Z-Contact%</th><th scope="col">SwStr%</th></tr></thead>
        <tbody>${pts.map((p) => { const x = p.plate_discipline || {}; return `<tr><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${p.pitches}</td><td>${pct1(x.o_swing_pct)}</td><td>${pct1(x.z_swing_pct)}</td><td>${pct1(x.swing_pct)}</td><td>${pct1(x.o_contact_pct)}</td><td>${pct1(x.z_contact_pct)}</td><td>${pct1(x.swstr_pct)}</td></tr>`; }).join("")}</tbody></table></div>
        <h3 class="h-sub sub-h">Batted ball</h3>
        <div class="table-scroll"><table class="dt"><thead><tr><th scope="col">Pitch</th><th scope="col">BIP</th><th scope="col">LD%</th><th scope="col">GB%</th><th scope="col">FB%</th><th scope="col">IFFB%</th></tr></thead>
        <tbody>${pts.map((p) => { const x = p.batted_ball || {}; return `<tr><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${x.balls_in_play ?? NA}</td><td>${pct1(x.ld_pct)}</td><td>${pct1(x.gb_pct)}</td><td>${pct1(x.fb_pct)}</td><td>${pct1(x.iffb_pct)}</td></tr>`; }).join("")}</tbody></table></div>`;
    } catch { if (alive && host.isConnected) host.innerHTML = `<div class="state-inline">Couldn't load this split.</div>`; }
  }
  $("#body-arsenal").addEventListener("toggle", (e) => { if (e.target.id === "pitch-detail" && e.target.open) loadPitchDetail(); }, true);
  $("#body-arsenal").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ah]");
    if (!b) return;
    arsenalHand = b.dataset.ah;
    root.querySelectorAll("[data-ah]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    loadPitchDetail();
  });

  // ----- Same-handed starters: the evidence ledger -----
  let venue = "";
  let starters = [];
  async function loadSameHanded() {
    if (!ctx.opponent) { setFact("samehand", `<span class="faint">Opponent unknown</span>`); setBody("samehand", ""); return; }
    if (!hand) { setFact("samehand", `<span class="faint">Handedness unavailable</span>`); setBody("samehand", `<div class="state-inline">His throwing hand couldn't be loaded, so same-handed starters can't be matched.</div>`); return; }
    try {
      starters = (await api.sameHanded(ctx.opponent, hand)).starters || [];
      if (alive) paintSameHanded();
    } catch { if (alive) fail("samehand", "same-handed starters"); }
  }
  function paintSameHanded() {
    const key = ["strikeouts", "walks", "hits_allowed", "earned_runs"].includes(ctx.statKey) ? ctx.statKey : "strikeouts";
    const label = STATS.find((s) => s.key === key).short;
    const rows = venue ? starters.filter((s) => s.venue_relation === venue) : starters;
    const hp = hand === "R" ? "RHP" : "LHP";
    // His line is a reference only when this section shows the prop's own stat.
    const opts = { key, label, line: ctx.line != null && key === ctx.statKey ? ctx.line : null, selection: ctx.selection || "Over", pitcherName: ctx.name, hp, oppAbbr };
    // Starts without a recorded value are left out of the average, not counted as 0.
    const sum = evidenceSummary(rows, opts);
    toc("samehand", sum.n ? `${sum.n} ${hp} starts, ${sum.mean.toFixed(1)} ${label} avg` : "None found");
    setFact("samehand", sum.n
      ? `<span><b class="num">${sum.n}</b> recent ${hp} starts against ${esc(oppAbbr)} averaged <b class="num">${sum.mean.toFixed(1)}</b> ${label}${sum.over != null ? `; <b class="num">${sum.over}</b> of them went ${esc(ctx.selection.toLowerCase())} ${esc(fmtLine(ctx.line))}` : ""}.</span>`
      : `<span class="faint">No recent ${hp} starts found in this split.</span>`);
    setBody("samehand", `
      <div class="toolbar">
        <div class="seg seg-sm" role="radiogroup" aria-label="Venue">${[["", "All parks"], ["at_opponent_park", `At ${oppAbbr}`], ["at_starter_home_park", "At starter's park"]].map(([v, l]) => `<button type="button" role="radio" data-venue="${v}" aria-checked="${venue === v}">${esc(l)}</button>`).join("")}</div>
      </div>
      ${evidenceLedger(rows, opts)}`);
  }
  $("#body-samehand").addEventListener("click", (e) => {
    const b = e.target.closest("[data-venue]");
    if (!b) return;
    venue = b.dataset.venue; paintSameHanded();
  });

  // ----- Season profile: the gradecard -----
  function paintSeason() {
    const s = stats.season || {};
    const g = gradecard(stats);
    toc("season", `K ${s.k_pct != null ? s.k_pct.toFixed(1) + "%" : "-"}, BB ${s.bb_pct != null ? s.bb_pct.toFixed(1) + "%" : "-"}`);
    setFact("season", `<span>Better than MLB average in <b class="num">${g.better}</b> of <b class="num">${g.known}</b> measures. ERA <b class="num">${s.era != null ? s.era.toFixed(2) : "-"}</b>, WHIP <b class="num">${s.whip != null ? s.whip.toFixed(2) : "-"}</b> over <b class="num">${esc(s.innings_pitched ?? "-")}</b> IP.</span>`);
    setBody("season", g.html);
  }

  // ----- Environment rail -----
  async function loadEnvironment() {
    const g = slate?.games.find((x) => x.home_team === ctx.home_team && (!ctx.game_time || Math.abs(new Date(x.game_time) - new Date(ctx.game_time)) < 12 * 3600_000));
    $("#ctx-game").innerHTML = ctx.home_team
      ? `<div class="kv"><span>First pitch</span><b>${esc(ctx.game_time ? `${relDay(ctx.game_time)} ${time(ctx.game_time)}` : "Time TBD")}</b></div>
         <div class="kv"><span>Venue</span><b>${esc(g?.venue || ctx.home_team)}</b></div>
         ${g?.status ? `<div class="kv"><span>Status</span><b>${esc(g.status)}</b></div>` : ""}`
      : `<p class="faint">No scheduled game found.</p>`;

    const validTime = ctx.game_time && !isNaN(new Date(ctx.game_time).getTime());
    // The roof comes from MLB's venue name: a dome has no weather, and a retractable
    // roof's open/closed call isn't in the data, so wind and HR impact aren't estimated.
    const roof = ROOFS[g?.venue] || null;
    if (roof === "dome") {
      $("#ctx-wx").innerHTML = `<p class="faint">Indoors at ${esc(g.venue)}: outdoor weather doesn't apply.</p>`;
    } else if (ctx.home_team && validTime) {
      api.weather(ctx.home_team, ctx.game_time).then((w) => {
        if (!alive) return;
        const gt = w.weather?.game_time;
        const hr = w.hr_impact_estimate;
        // The forecast only covers now onward: an hour more than 90 minutes from
        // first pitch (a game already played) is not this game's weather.
        const at = gt?.forecast_time ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(gt.forecast_time) ? gt.forecast_time : `${gt.forecast_time}Z`) : NaN;
        const matches = gt && !isNaN(at) && Math.abs(at - new Date(ctx.game_time).getTime()) <= 90 * 60_000;
        $("#ctx-wx").innerHTML = matches
          ? `<div class="wx">
               <div class="wx-temp"><span class="num">${gt.temperature_f != null ? Math.round(gt.temperature_f) : "-"}</span><span>°F</span></div>
               <div class="wx-meta"><span>${esc(weatherLabel(gt.weather_code))}</span><span>Humidity <b class="num">${gt.humidity_pct != null ? Math.round(gt.humidity_pct) + "%" : "-"}</b></span></div>
             </div>
             ${roof ? "" : `<div class="kv"><span>Wind</span><b><span class="num">${gt.wind_mph != null ? Math.round(gt.wind_mph) : "-"}</span> mph${w.wind?.label ? `, ${esc(w.wind.label)}` : ""}</b></div>
             ${hr && hr.estimated_hr_pct_change != null ? `<div class="kv" title="${esc(hr.warning || "Estimate")}"><span>HR impact (est.)</span><b class="num">${hr.estimated_hr_pct_change >= 0 ? "+" : ""}${hr.estimated_hr_pct_change}%</b></div>` : ""}`}
             ${gt.precipitation_probability != null ? `<div class="kv"><span>Rain chance</span><b class="num">${Math.round(gt.precipitation_probability)}%</b></div>` : ""}
             <p class="ctx-note">${roof ? `Forecast outside ${esc(g.venue)}, which has a retractable roof; whether it will be open isn't in the data, so wind and HR impact aren't estimated.` : "Forecast for first pitch."}</p>`
          : `<p class="faint">No forecast for this game time.</p>`;
      }).catch(() => { if (alive) $("#ctx-wx").innerHTML = `<p class="faint">Couldn't load the forecast.</p>`; });
    } else $("#ctx-wx").innerHTML = `<p class="faint">Needs a scheduled game time.</p>`;

    if (ctx.home_team) {
      api.parkFactors(ctx.home_team).then((p) => {
        if (!alive) return;
        const f = p.factors;
        if (!f) { $("#ctx-park").innerHTML = `<p class="faint">Not available.</p>`; return; }
        const bar = (label, v) => {
          const d = v - 100;
          const w = Math.min(50, Math.abs(d) * 2.5);
          return `<div class="pf" role="img" aria-label="${label} ${d >= 0 ? "+" : ""}${d}% versus an average park">
            <span class="pf-l">${label}</span>
            <span class="pf-track"><span class="pf-mid"></span><span class="pf-bar ${d >= 0 ? "up" : "dn"}" style="${d >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`}"></span></span>
            <span class="pf-v num">${d >= 0 ? "+" : ""}${d}%</span></div>`;
        };
        $("#ctx-park").innerHTML = `
          ${bar("HR", f.hr)}${bar("2B/3B", f.doubles_triples)}${bar("1B", f.singles)}${bar("Runs", f.runs)}
          <p class="ctx-note">${esc(f.venue || ctx.home_team)}. Historical approximation against a neutral 100, not live-computed.</p>`;
      }).catch(() => { if (alive) $("#ctx-park").innerHTML = `<p class="faint">Couldn't load park factors.</p>`; });
    } else $("#ctx-park").innerHTML = `<p class="faint">No home park found.</p>`;
  }

  boot();
  return () => { alive = false; cleanups.forEach((f) => f()); document.title = "PWR Props"; };
}

// "Chris Sale" -> ["Chris", "Sale"]; "Luis L. Ortiz" -> ["Luis L.", "Ortiz"];
// a Jr./Sr. suffix stays with the surname.
function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ["", parts[0] || ""];
  let cut = parts.length - 1;
  if (cut > 1 && /^(jr|sr|ii|iii|iv)\.?$/i.test(parts[cut])) cut--;
  return [parts.slice(0, cut).join(" "), parts.slice(cut).join(" ")];
}

function pitchPlural(p) {
  const n = String(p.pitch_name || p.pitch_type).replace("4-Seam Fastball", "four-seam fastball").toLowerCase();
  return n.endsWith("s") ? n : `${n}s`;
}

function shortPitch(p) {
  return String(p.pitch_name || p.pitch_type).replace("4-Seam Fastball", "Four-seam").replace("Knuckle Curve", "Knuckle curve");
}

function weatherLabel(code) {
  if (code == null) return "";
  if (code === 0) return "Clear";
  if (code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Showers";
  if (code >= 95) return "Storms";
  return "Clear";
}
