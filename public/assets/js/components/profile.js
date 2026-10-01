// OPPONENT PROFILE and SEASON GRADECARD.
import { esc, NA, pct1, avg3 } from "../format.js";
import { LEAGUE_AVG, weightedAvg } from "../domain.js";

const MIN_PA = 150; // pitch types below this many PA are too thin to profile on

const plural = (n) => {
  const s = String(n).replace("4-Seam Fastball", "four-seam fastball").toLowerCase();
  return s.endsWith("s") ? s : `${s}s`;
};

/**
 * What this offense does well and poorly, from its real season results by
 * pitch type (every pitcher it faced). The reference lines are the team's own
 * PA-weighted averages across all pitch types, not an invented league number.
 * Team K% is compared with the fixed MLB reference in LEAGUE_AVG.
 */
export function opponentModel(splits, { summary, arsenal, oppAbbr }) {
  const all = (splits || []).filter((s) => s.pa && s.whiff_pct != null && s.est_woba != null);
  const rows = all.filter((s) => s.pa >= MIN_PA);
  if (rows.length < 2) return null;
  const whiffAvg = weightedAvg(all, (s) => s.whiff_pct, (s) => s.pa);
  const wobaAvg = weightedAvg(all, (s) => s.est_woba, (s) => s.pa);
  const struggle = [...rows].sort((a, b) => b.whiff_pct - a.whiff_pct)[0];
  const damage = [...rows].sort((a, b) => b.est_woba - a.est_woba)[0];
  const usage = new Map((arsenal || []).map((p) => [p.pitch_type, p.usage_pct]));
  return { rows, whiffAvg, wobaAvg, struggle, damage, usage, k: summary?.k ?? null, oppAbbr, omitted: all.length - rows.length };
}

export function opponentFact(m) {
  if (!m) return "";
  const k = m.k != null
    ? `${esc(m.oppAbbr)} strikes out <b>${m.k.toFixed(1)}%</b> of the time, ${m.k > LEAGUE_AVG.k_pct ? "more" : "less"} than the <b>${LEAGUE_AVG.k_pct}%</b> MLB average. `
    : "";
  return `${k}They miss most against <b>${esc(plural(m.struggle.pitch_name || m.struggle.pitch_type))}</b> and do the most damage against <b>${esc(plural(m.damage.pitch_name || m.damage.pitch_type))}</b>.`;
}

export function opponentProfile(m) {
  if (!m) return `<div class="state-inline">Not enough pitch-type results to profile this offense.</div>`;
  const uses = (s) => {
    const u = m.usage.get(s.pitch_type);
    return u != null ? `He throws it ${u.toFixed(1)}% of the time.` : "Not in his arsenal.";
  };
  // The findings are an open editorial column; the plot beside it is the
  // main object, with the same two findings ringed on it.
  const find = (cls, kick, s, lead, rest) => `
    <div class="op-f ${cls}">
      <span class="op-kick"><i class="op-ring-key" aria-hidden="true"></i>${kick}</span>
      <b class="op-pitch">${esc(plural(s.pitch_name || s.pitch_type))}</b>
      <span class="op-lead">${lead}</span>
      <span class="op-rest num">${rest}</span>
      <span class="op-uses">${uses(s)}</span>
    </div>`;
  return `
    <div class="op">
      <div class="op-find">
        ${find("struggle", "Misses most", m.struggle, `<b>${m.struggle.whiff_pct.toFixed(1)}%</b> whiff`, `${avg3(m.struggle.est_woba)} xwOBA · ${m.struggle.pa.toLocaleString()} PA`)}
        ${find("damage", "Does most damage", m.damage, `<b>${avg3(m.damage.est_woba)}</b> xwOBA`, `${m.damage.whiff_pct.toFixed(1)}% whiff · ${m.damage.pa.toLocaleString()} PA`)}
        ${m.k != null ? `
        <div class="op-f op-k">
          <span class="op-kick">Team strikeout rate</span>
          <b class="op-pitch">${m.k.toFixed(1)}<small>%</small></b>
          <span class="op-meter" role="img" aria-label="${esc(m.oppAbbr)} ${m.k.toFixed(1)}%, MLB average ${LEAGUE_AVG.k_pct}%"><span class="op-meter-fill" style="width:${Math.min(100, (m.k / 35) * 100).toFixed(1)}%"></span><span class="op-meter-avg" style="left:${((LEAGUE_AVG.k_pct / 35) * 100).toFixed(1)}%"></span></span>
          <span class="op-rest">${m.k > LEAGUE_AVG.k_pct ? "Above" : "Below"} the ${LEAGUE_AVG.k_pct}% MLB average</span>
        </div>` : ""}
      </div>
      <figure class="op-fig">
        <figcaption class="op-cap"><b>Every pitch type they see</b><span>Across: how often they miss. Up: how hard they hit it. Lines: ${esc(m.oppAbbr)}'s own averages.</span></figcaption>
        <div class="op-plot" aria-hidden="true"></div>
        <ul class="sr-only">${m.rows.map((s) => `<li>${esc(s.pitch_name || s.pitch_type)}: ${s.whiff_pct.toFixed(1)}% whiff, ${avg3(s.est_woba)} xwOBA, ${s.pa} PA${m.usage.has(s.pitch_type) ? ", in his arsenal" : ""}.</li>`).join("")}</ul>
        <div class="op-legend"><span><i class="op-dot his"></i>He throws it</span><span><i class="op-dot"></i>Not in his arsenal</span><span><i class="op-dot ring"></i>The two findings</span>${m.omitted ? `<span>${m.omitted} pitch ${m.omitted === 1 ? "type" : "types"} under ${MIN_PA} PA left out</span>` : ""}</div>
      </figure>
    </div>`;
}

/** Draws the profile scatter at the host's real width (called again on resize). */
export function drawProfilePlot(host, m) {
  if (!host || !m) return;
  const W = Math.max(280, host.clientWidth);
  const narrow = W < 440;
  // The plot is the chapter's main object: tall on wide screens, compact on phones.
  const H = narrow ? 280 : Math.round(Math.min(500, Math.max(380, W * 0.92)));
  const mg = { l: 46, r: 14, t: 26, b: 38 };
  const pw = W - mg.l - mg.r, ph = H - mg.t - mg.b;
  const ws = m.rows.map((s) => s.whiff_pct), os = m.rows.map((s) => s.est_woba);
  const x0 = Math.floor(Math.min(...ws, m.whiffAvg) / 5) * 5, x1 = Math.ceil(Math.max(...ws, m.whiffAvg) / 5) * 5;
  const y0 = Math.floor(Math.min(...os, m.wobaAvg) * 40) / 40, y1 = Math.ceil(Math.max(...os, m.wobaAvg) * 40) / 40;
  const X = (v) => mg.l + ((v - x0) / (x1 - x0)) * pw;
  const Y = (v) => mg.t + ph - ((v - y0) / (y1 - y0)) * ph;
  const xt = []; for (let v = x0; v <= x1 + 1e-9; v += 5) xt.push(v);
  const yt = []; for (let v = y0; v <= y1 + 1e-9; v += 0.025) yt.push(v);
  // Labels: try right, left, above, below; keep the first spot that collides with nothing.
  const placed = [];
  const pts = m.rows.map((s) => ({ s, x: X(s.whiff_pct), y: Y(s.est_woba), his: m.usage.has(s.pitch_type), key: s === m.struggle || s === m.damage }));
  pts.forEach((p) => { const r = p.key ? 15 : 7; placed.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r }); });
  const hits = (b) => placed.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
  const labels = [...pts].sort((a, b) => a.y - b.y).map((p) => {
    const text = p.s.pitch_name || p.s.pitch_type;
    const w = text.length * (p.key ? 10 : 6.6) + 4, h = p.key ? 17 : 14;
    const o = p.key ? 18 : 10;
    const spots = [[o, -7], [-o - w, -7], [-w / 2, -o - 14], [-w / 2, o]];
    let pick = spots[0];
    for (const sp of spots) {
      const b = { x: p.x + sp[0], y: p.y + sp[1], w, h };
      if (b.x >= mg.l - 4 && b.x + w <= W && !hits(b)) { pick = sp; break; }
    }
    placed.push({ x: p.x + pick[0], y: p.y + pick[1], w, h });
    return `<text class="op-lbl ${p.his ? "his" : ""} ${p.key ? "key" : ""}" x="${(p.x + pick[0] + 2).toFixed(1)}" y="${(p.y + pick[1] + 11).toFixed(1)}">${esc(text)}</text>`;
  }).join("");
  // Quadrant names go in whichever corner of their quadrant is empty.
  const cx = X(m.whiffAvg), cy = Y(m.wobaAvg);
  const quad = (text, corners) => {
    const w = text.length * 7.6 + 6, h = 16;
    for (const [x, y] of corners) {
      const b = { x, y, w, h };
      if (!hits(b)) { placed.push(b); return `<text class="op-q" x="${(x + 3).toFixed(1)}" y="${(y + 12).toFixed(1)}">${text}</text>`; }
    }
    return "";
  };
  const qTL = quad("Handles it", [[mg.l + 6, mg.t + 2], [cx - 6 - 86, mg.t + 2], [mg.l + 6, cy - 20], [cx - 6 - 86, cy - 20]]);
  const qBR = quad("Struggles", [[W - mg.r - 80, mg.t + ph - 20], [W - mg.r - 80, cy + 6], [cx + 6, mg.t + ph - 20], [cx + 6, cy + 6]]);
  host.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" focusable="false">
      ${yt.map((v) => `<line class="op-grid" x1="${mg.l}" x2="${W - mg.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="op-yt" x="${mg.l - 8}" y="${Y(v) + 4}">${v.toFixed(3).replace(/^0/, "")}</text>`).join("")}
      ${xt.map((v) => `<text class="op-xt" x="${X(v)}" y="${H - 18}">${v}%</text>`).join("")}
      <text class="op-ax" x="${W - mg.r}" y="${H - 3}">whiff% →</text>
      <text class="op-ax y" x="0" y="12">↑ xwOBA</text>
      <rect class="op-zone handle" x="${mg.l}" y="${mg.t}" width="${Math.max(0, cx - mg.l)}" height="${Math.max(0, cy - mg.t)}"/>
      <rect class="op-zone struggle" x="${cx}" y="${cy}" width="${Math.max(0, W - mg.r - cx)}" height="${Math.max(0, mg.t + ph - cy)}"/>
      <line class="op-avg" x1="${X(m.whiffAvg)}" x2="${X(m.whiffAvg)}" y1="${mg.t}" y2="${mg.t + ph}"/>
      <line class="op-avg" x1="${mg.l}" x2="${W - mg.r}" y1="${Y(m.wobaAvg)}" y2="${Y(m.wobaAvg)}"/>
      ${qTL}${qBR}
      ${pts.filter((p) => p.key).map((p) => `<circle class="op-ring" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${narrow ? 11 : 13}"/>`).join("")}
      ${pts.map((p) => `<circle class="op-pt ${p.his ? "his" : ""}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${narrow ? 5 : 6}"/>`).join("")}
      ${labels}
    </svg>`;
}

/**
 * SEASON GRADECARD. His real 2026 rates against fixed MLB reference values,
 * read from the pitcher's side: for most contact measures lower is better,
 * for K% higher is better. The count of better measures is the statement;
 * the measures are organized under it by subject. Bars show how far from
 * average, better or worse, as a share of the average itself (capped at 50%).
 */
export function gradecard(stats) {
  const b = stats?.barrels || {}, x = stats?.expected || {}, s = stats?.season || {};
  const pct = (v) => `${v.toFixed(1)}%`;
  const three = (v) => v.toFixed(3).replace(/^0/, "");
  const groups = [
    ["Strikeouts and walks", [["K%", s.k_pct, LEAGUE_AVG.k_pct, pct, false], ["BB%", s.bb_pct, LEAGUE_AVG.bb_pct, pct, true]]],
    ["Contact allowed", [["Barrel%", b.barrel_pct, LEAGUE_AVG.barrel_pct, pct, true], ["Hard-hit%", b.hard_hit_pct, LEAGUE_AVG.hard_hit_pct, pct, true], ["Sweet-spot%", b.sweet_spot_pct, LEAGUE_AVG.sweet_spot_pct, pct, true]]],
    ["Results allowed", [["BA", x.ba, LEAGUE_AVG.ba, three, true], ["xBA", x.est_ba, LEAGUE_AVG.est_ba, three, true], ["xSLG", x.est_slg, LEAGUE_AVG.est_slg, three, true], ["wOBA", x.woba, LEAGUE_AVG.woba, three, true]]],
  ];
  const all = groups.flatMap(([, r]) => r);
  const known = all.filter(([, v]) => v != null);
  const good = ([, v, a, , low]) => (low ? v < a : v > a);
  const better = known.filter(good).length;
  const misses = known.filter((r) => !good(r));
  const missText = !known.length ? "" : !misses.length
    ? "Better than average on every measure with data."
    : misses.length === 1
      ? `The one miss: <b>${misses[0][0]}</b> at ${misses[0][3](misses[0][1])}, against an MLB average of ${misses[0][3](misses[0][2])}.`
      : `Worse than average on ${misses.map((r) => `<b>${r[0]}</b>`).join(", ")}.`;
  const row = ([label, v, a, f, low]) => {
    if (v == null) return `<div class="gc-row na"><div class="gc-rt"><span class="gc-l">${label}</span><span class="gc-tag">No data</span></div><div class="gc-rv"><b class="gc-v">${NA}</b><span class="gc-avg num">MLB ${f(a)}</span></div></div>`;
    const ok = good([label, v, a, f, low]);
    const w = (Math.min(0.5, Math.abs(v - a) / a) / 0.5) * 50;
    return `
      <div class="gc-row ${ok ? "better" : "worse"}">
        <div class="gc-rt"><span class="gc-l">${label}</span><span class="gc-tag">${ok ? "Better" : "Worse"}</span></div>
        <div class="gc-rv"><b class="gc-v">${f(v)}</b><span class="gc-avg num">MLB ${f(a)}</span></div>
        <span class="gc-bar" role="img" aria-label="${label} ${f(v)} against an MLB average of ${f(a)}: ${ok ? "better" : "worse"} for a pitcher"><span class="gc-mid"></span><span class="gc-fill" style="${ok ? `left:50%;width:${w.toFixed(1)}%` : `right:50%;width:${w.toFixed(1)}%`}"></span></span>
        <small class="gc-dir">${low ? "Lower is better" : "Higher is better"}</small>
      </div>`;
  };
  const top = [["ERA", s.era != null ? s.era.toFixed(2) : null], ["xERA", x.xera != null ? x.xera.toFixed(2) : null], ["WHIP", s.whip != null ? s.whip.toFixed(2) : null], ["IP", s.innings_pitched ?? null], ["K", s.strikeouts ?? null], ["BB", s.walks ?? null]];
  return {
    better, known: known.length,
    html: `
    <div class="gc">
      <div class="gc-hero">
        <div class="gc-score" aria-label="${better} of ${known.length} measures better than MLB average"><b>${better}</b><i>/${known.length}</i></div>
        <div class="gc-state">
          <span class="gc-say">Measures better than MLB average</span>
          <span class="tally gc-tally" aria-hidden="true">${known.map((r) => `<i class="${good(r) ? "on" : "off"}" title="${r[0]}"></i>`).join("")}</span>
          <p class="gc-miss">${missText}</p>
        </div>
        <dl class="gc-line">${top.map(([k, v]) => `<div><dt>${k}</dt><dd>${v ?? NA}</dd></div>`).join("")}</dl>
      </div>
      <div class="gc-cols">
        ${groups.map(([title, rows]) => `<section class="gc-g"><h3 class="gc-h">${title}</h3>${rows.map(row).join("")}</section>`).join("")}
      </div>
      <p class="gc-key" aria-hidden="true"><span><i class="gc-key-mid"></i>MLB average</span><span><i class="gc-key-b"></i>Better, bar to the right</span><span><i class="gc-key-w"></i>Worse, bar to the left</span></p>
      <p class="viz-note">MLB averages are fixed reference values, not live. Better and worse are from the pitcher's side; bars show the distance from average as a share of the average, capped at 50%. ERA, xERA and WHIP have no MLB reference in this data, so they are shown without a comparison. FIP is not available from this source.</p>
    </div>`,
  };
}
