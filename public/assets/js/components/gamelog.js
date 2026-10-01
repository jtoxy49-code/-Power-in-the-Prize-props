// Game log chart: the whole season is the ground, the selected sample is lit,
// and a gold bracket spans exactly the starts behind the hit rate.
// Encoding (dataviz audit):
//   x order     = chronological start (ordinal, oldest to newest)
//   x width     = focus + context: starts outside the selected sample are
//                 drawn narrower and dimmed. Order is never changed and no
//                 start is dropped, so the season stays readable as context.
//   height      = stat value on a zero-based linear axis
//   fill        = outcome vs the line: solid = hit, hatched = miss
//   color       = the same outcome again (hit #5cc27a / miss #a44a5a, CVD dE 20)
//   bracket     = gold rule from the first to the last start in the sample,
//                 with a tick on every start that counts
// With no line posted, bars are neutral: no outcome is implied. A start with
// no recorded value is drawn as a labeled gap, never as a 0 bar.
import { esc, line as fmtLine, NA } from "../format.js";
import { abbr, isHit, formatInnings, statOf, postseasonRound } from "../domain.js";

let uid = 0;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function mountGameLog(host, { onFocusGame, onLayout } = {}) {
  const id = `gl${++uid}`;
  host.innerHTML = `
    <div class="gl" id="${id}">
      <div class="gl-plot" tabindex="0" role="group" aria-roledescription="chart"></div>
      <div class="gl-tip" role="status" aria-live="polite"></div>
      <div class="gl-table" hidden></div>
    </div>`;
  const root = host.querySelector(".gl");
  const plot = host.querySelector(".gl-plot");
  const tip = host.querySelector(".gl-tip");
  const tableEl = host.querySelector(".gl-table");
  let data = null;
  let built = "";      // signature of the drawn columns; same signature = animate in place
  let focusIdx = -1;

  const ro = new ResizeObserver(() => data && !plot.hidden && layout());
  ro.observe(plot);

  // Weight of a start outside the sample. Narrow screens compress context harder
  // so the lit starts keep room for their values.
  const dimWeight = () => (plot.clientWidth < 560 ? 0.3 : 0.4);
  const weights = () => {
    const anyLit = data.lit.some(Boolean);
    const all = data.lit.every(Boolean);
    const d = dimWeight();
    return data.lit.map((l) => (!anyLit || all || l ? 1 : d));
  };

  function draw() {
    const { games, statKey, line, selection } = data;
    if (!games.length) {
      built = "";
      plot.innerHTML = `<div class="state-inline">${esc(data.emptyText || "No starts in this sample.")}</div>`;
      plot.setAttribute("aria-label", data.emptyText || "No starts in this sample");
      onLayout?.({ inset: 0 });
      return;
    }
    const values = games.map((g) => statOf(g, statKey));
    const sig = `${games.length}|${games[0].date}|${games.at(-1).date}|${statKey}|${line}|${selection}`;
    if (sig !== built) {
      const top = Math.max(...values.filter((v) => v != null), line ?? 0, 1);
      const yMax = top + Math.max(1, top * 0.18); // headroom for the value above the tallest bar
      const pctH = (v) => `${Math.max(1.5, (v / yMax) * 100).toFixed(2)}%`;
      let month = -1;
      plot.innerHTML = `
        <div class="gl-cols">
          ${games.map((g, i) => {
            const v = values[i];
            const m = g.date ? Number(g.date.slice(5, 7)) - 1 : -1;
            const mo = m !== month ? MONTHS[m] || "" : "";
            month = m;
            const date = g.date ? `${Number(g.date.slice(5, 7))}/${Number(g.date.slice(8, 10))}` : "";
            const outcome = v == null ? "x" : line == null ? "n" : isHit(v, line, selection) ? "h" : "m";
            return `
              <div class="gl-col ${outcome}" data-i="${i}">
                <span class="gl-brk" aria-hidden="true"></span>
                <span class="gl-well">
                  ${v == null
                    ? `<span class="gl-nd">n/a</span>`
                    : `<span class="gl-bar" style="height:${pctH(v)}"><span class="gl-v">${v}</span></span>`}
                </span>
                <span class="gl-lab"><b>${g.is_home ? "" : "@"}${esc(abbr(g.opponent))}</b><i>${date}${postseasonRound(g) ? ` ${postseasonRound(g).short}` : ""}</i></span>
                ${mo ? `<span class="gl-mo">${mo}</span>` : ""}
              </div>`;
          }).join("")}
        </div>
        <div class="gl-layer" aria-hidden="true">${line != null ? `<div class="gl-line" style="bottom:${((line / yMax) * 100).toFixed(2)}%"><span class="gl-line-tag">${selection === "Under" ? "U" : "O"} ${esc(fmtLine(line))}</span></div>` : ""}</div>`;
      plot.classList.add("no-anim");
      built = sig;
    }
    paintSample();
    layout();
    // Let the first paint land without transitions, then animate sample changes.
    requestAnimationFrame(() => requestAnimationFrame(() => plot.classList.remove("no-anim")));

    const inSample = games.map((g, i) => (data.lit[i] ? values[i] : undefined)).filter((v) => v !== undefined);
    const known = inSample.filter((v) => v != null);
    const hits = line == null ? null : known.filter((v) => isHit(v, line, selection)).length;
    plot.setAttribute("aria-label",
      `${data.statLabel} in each of his ${games.length} ${data.unit || "start"}s this season, oldest to newest. ` +
      `The selected sample, ${data.sampleText}, is highlighted.` +
      (line != null ? ` ${selection} ${fmtLine(line)} hit in ${hits} of ${known.length} of those starts with a recorded value.` : " No line posted.") +
      " Use left and right arrow keys to read each start.");
    if (focusIdx >= games.length) focusIdx = games.length - 1;
    if (focusIdx >= 0) mark(focusIdx, false);
  }

  // Which starts are lit, where the bracket runs, and how wide each start is.
  function paintSample() {
    const lit = data.lit;
    const first = lit.indexOf(true);
    const last = lit.lastIndexOf(true);
    const w = weights();
    plot.querySelectorAll(".gl-col").forEach((c, i) => {
      c.style.flexGrow = w[i];
      c.classList.toggle("in", lit[i]);
      c.classList.toggle("span", first >= 0 && i >= first && i <= last);
      c.classList.toggle("bs", i === first);
      c.classList.toggle("be", i === last);
    });
  }

  // Label density follows the room a lit start actually gets; the readout above
  // is told where the bracket ends so the headline sits on it.
  function layout() {
    if (!data?.games.length) return;
    const W = plot.clientWidth;
    const w = weights();
    const total = w.reduce((s, x) => s + x, 0);
    const unit = W / total;
    const lit = data.lit;
    const litBand = lit.some(Boolean) ? unit : 0;
    plot.dataset.band = litBand >= 40 ? "l" : litBand >= 26 ? "m" : litBand >= 16 ? "s" : "xs";
    // Every other label when lit starts are too narrow for one each.
    const every = litBand >= 26 ? 1 : 2;
    const lastLit = lit.lastIndexOf(true);
    // Month marks label the dimmed context. Newest first, so when two would
    // collide (a lone late-March start next to April) the later month wins.
    const cols = [...plot.querySelectorAll(".gl-col")];
    const xs = [];
    cols.reduce((x, c, i) => { xs[i] = x; return x + w[i] * unit; }, 0);
    cols.forEach((c, i) => {
      const show = lit[i] && ((lastLit - i) % every === 0 || every === 1);
      c.classList.toggle("lab-off", !show);
    });
    let nextMo = Infinity;
    for (let i = cols.length - 1; i >= 0; i--) {
      if (lit[i]) { if (!cols[i].classList.contains("lab-off")) nextMo = xs[i]; continue; }
      if (!cols[i].querySelector(".gl-mo")) continue;
      const room = !lit[i] && nextMo - xs[i] >= 30;
      cols[i].classList.toggle("mo-off", !room);
      if (room) nextMo = xs[i];
    }
    if (lastLit < 0) { onLayout?.({ inset: 0 }); return; }
    const before = w.slice(0, lastLit + 1).reduce((s, x) => s + x, 0) * unit;
    const colW = w[lastLit] * unit;
    const bar = Math.min(26, colW * 0.56);
    onLayout?.({ inset: Math.max(0, W - (before - (colW - bar) / 2)) });
  }

  function describe(i) {
    const g = data.games[i];
    const v = statOf(g, data.statKey);
    return { g, v };
  }

  function mark(i, announce = true) {
    focusIdx = i;
    const cols = plot.querySelectorAll(".gl-col");
    cols.forEach((b) => b.classList.toggle("focus", Number(b.dataset.i) === i));
    const { g, v } = describe(i);
    const hit = data.line == null || v == null ? null : isHit(v, data.line, data.selection);
    tip.innerHTML = `
      <span class="gl-tip-date">${esc(g.date)} ${g.is_home ? "vs" : "@"} ${esc(g.opponent)}${postseasonRound(g) ? `, ${postseasonRound(g).long}` : ""}</span>
      <span class="gl-tip-val">${v == null ? `<span class="faint">No recorded ${esc(data.statShort)}</span>` : `<b class="num">${v}</b> ${esc(data.statShort)}`}${hit == null ? "" : hit ? ` <span class="pos">Hit</span>` : ` <span class="neg">Miss</span>`}${data.lit[i] ? "" : ` <span class="faint">(outside sample)</span>`}</span>
      <span class="gl-tip-meta num">${esc(g.innings_pitched ?? "-")} IP · ${g.pitches_thrown ?? "-"} P · ${g.batters_faced ?? "-"} BF${g.csw_pct != null ? ` · ${g.csw_pct}% CSW` : ""}</span>`;
    tip.classList.add("on");
    // Follow the start, clamped to the chart.
    const col = cols[i];
    if (col) {
      const r = col.getBoundingClientRect(), pr = root.getBoundingClientRect();
      const x = r.left - pr.left + r.width / 2 - tip.offsetWidth / 2;
      tip.style.left = `${Math.max(0, Math.min(pr.width - tip.offsetWidth, x))}px`;
    }
    if (announce && onFocusGame) onFocusGame(g);
  }

  plot.addEventListener("pointermove", (e) => {
    const b = e.target.closest(".gl-col");
    if (b) mark(Number(b.dataset.i));
  });
  plot.addEventListener("pointerleave", () => {
    tip.classList.remove("on");
    plot.querySelectorAll(".gl-col.focus").forEach((b) => b.classList.remove("focus"));
  });
  plot.addEventListener("keydown", (e) => {
    if (!data?.games.length) return;
    const n = data.games.length;
    if (e.key === "ArrowRight") mark(focusIdx < 0 ? n - 1 : Math.min(n - 1, focusIdx + 1));
    else if (e.key === "ArrowLeft") mark(focusIdx < 0 ? n - 1 : Math.max(0, focusIdx - 1));
    else if (e.key === "Home") mark(0);
    else if (e.key === "End") mark(n - 1);
    else return;
    e.preventDefault();
  });
  plot.addEventListener("focus", () => { if (data?.games.length && focusIdx < 0) mark(data.games.length - 1); });
  plot.addEventListener("blur", () => tip.classList.remove("on"));

  // The table lists the selected sample only, newest first: the starts the hit rate counts.
  function table() {
    const { statKey, line, selection } = data;
    const games = data.games.filter((_, i) => data.lit[i]);
    if (!games.length) return `<div class="state-inline">${esc(data.emptyText || "No starts in this sample.")}</div>`;
    const rows = [...games].reverse().map((g) => {
      const v = statOf(g, statKey);
      const hit = line == null || v == null ? null : isHit(v, line, selection);
      return `<tr>
        <td class="txt">${esc(g.date)}${postseasonRound(g) ? ` ${postseasonRound(g).short}` : ""}</td>
        <td class="txt">${g.is_home ? "vs" : "@"} ${esc(abbr(g.opponent))}</td>
        <td>${esc(g.innings_pitched ?? "-")}</td><td>${g.strikeouts ?? NA}</td><td>${g.walks ?? NA}</td><td>${g.hits_allowed ?? NA}</td><td>${g.earned_runs ?? NA}</td><td>${g.outs ?? NA}</td>
        <td>${g.pitches_thrown ?? NA}</td><td>${g.batters_faced ?? NA}</td><td>${g.csw_pct != null ? `${g.csw_pct}%` : NA}</td>
        <td class="txt">${v == null ? '<span class="faint">No data</span>' : hit == null ? '<span class="faint">No line</span>' : hit ? '<span class="res hit">Hit</span>' : '<span class="res miss">Miss</span>'}</td>
      </tr>`;
    }).join("");
    return `
      <div class="table-scroll">
        <table class="dt gl-dt">
          <caption class="sr-only">Game log for the selected sample, newest first${line != null ? `, result against ${selection.toLowerCase()} ${fmtLine(line)}` : ""}</caption>
          <thead><tr><th scope="col">Date</th><th scope="col">Opp</th><th scope="col">IP</th><th scope="col">K</th><th scope="col">BB</th><th scope="col">H</th><th scope="col">ER</th><th scope="col">Outs</th><th scope="col">Pitches</th><th scope="col">BF</th><th scope="col">CSW%</th><th scope="col">${line != null ? `${selection} ${fmtLine(line)}` : "Result"}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  return {
    /** next: { games (full season, oldest first), lit (bool per game), statKey, statLabel, statShort, line, selection, sampleText, emptyText } */
    update(next) {
      data = next;
      if (tableEl.hidden) draw();
      else { tableEl.innerHTML = table(); onLayout?.({ inset: 0 }); }
    },
    setView(view) {
      const t = view === "table";
      tableEl.hidden = !t;
      plot.hidden = t;
      tip.classList.remove("on");
      if (data) {
        if (t) { tableEl.innerHTML = table(); onLayout?.({ inset: 0 }); }
        else { built = ""; draw(); }
      }
    },
    destroy() { ro.disconnect(); },
  };
}

/** Per-start averages for the same sample, as the original mini-stats row. */
export function sampleAverages(games, avgFn) {
  return {
    ip: formatInnings(avgFn(games.map((g) => g.outs))),
    pitches: avgFn(games.map((g) => g.pitches_thrown)),
    bf: avgFn(games.map((g) => g.batters_faced)),
    called: avgFn(games.map((g) => g.called_strikes)),
    swinging: avgFn(games.map((g) => g.swinging_strikes)),
    csw: avgFn(games.map((g) => g.csw_pct)),
  };
}
