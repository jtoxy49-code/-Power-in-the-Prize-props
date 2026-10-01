// Arsenal. Two measures with different denominators never share an encoding:
//   Usage   = share of ALL his pitches      -> bar length (0 to 100%)
//   Whiff%  = misses per SWING on that pitch -> dot position on its own 0-60% track
// Platoon usage (vs LHH / vs RHH) is derived from the per-hand pitch counts the
// splits endpoint already returns: pitches of that type / all pitches to that side.
import { esc, pct1, avg3, int, NA } from "../format.js";
import { icon } from "../icons.js";

const WHIFF_MAX = 60;

export function arsenalFact(arsenal) {
  if (!arsenal?.length) return "No pitch arsenal data for this pitcher yet.";
  const top = arsenal[0];
  const miss = [...arsenal].filter((p) => p.whiff_pct != null && (p.usage_pct || 0) >= 5).sort((a, b) => b.whiff_pct - a.whiff_pct)[0];
  const lead = `Throws ${arsenal.length} ${arsenal.length === 1 ? "pitch" : "pitches"}, led by the ${top.pitch_name || top.pitch_type} (${top.usage_pct?.toFixed(1)}% of pitches).`;
  return miss ? `${lead} The ${miss.pitch_name || miss.pitch_type} draws the most whiffs at ${miss.whiff_pct.toFixed(1)}%.` : lead;
}

export function platoonUsage(splitL, splitR) {
  const share = (split) => {
    const pts = split?.pitch_types || [];
    const total = pts.reduce((s, p) => s + (p.pitches || 0), 0);
    const m = new Map();
    pts.forEach((p) => m.set(p.pitch_type, total ? (100 * p.pitches) / total : null));
    return { m, total };
  };
  return { L: share(splitL), R: share(splitR) };
}

export function arsenalTable(arsenal, platoon) {
  if (!arsenal?.length) return `<div class="state-inline">No arsenal data available.</div>`;
  const hasPlatoon = platoon && (platoon.L.total || platoon.R.total);
  const rows = arsenal.map((p) => {
    const u = p.usage_pct; // null stays unknown: no bar is drawn, the value reads "-"
    const w = p.whiff_pct;
    const l = hasPlatoon ? platoon.L.m.get(p.pitch_type) : null;
    const r = hasPlatoon ? platoon.R.m.get(p.pitch_type) : null;
    return `
      <tr>
        <th scope="row" class="ars-name">
          <div class="ars-pitch"><span class="ars-pn">${esc(p.pitch_name || p.pitch_type)}</span><span class="num ars-u">${pct1(p.usage_pct)}</span></div>
          <span class="bar-track" aria-hidden="true">${u == null ? "" : `<span class="bar" style="width:${Math.min(100, u)}%"></span>`}</span>
        </th>
        ${hasPlatoon ? `<td class="ars-plat">${l == null ? NA : `${l.toFixed(1)}%`}</td><td class="ars-plat">${r == null ? NA : `${r.toFixed(1)}%`}</td>` : ""}
        <td class="ars-whiff">
          <span class="dot-track" aria-hidden="true">${w == null ? "" : `<span class="dot" style="left:${Math.min(100, (w / WHIFF_MAX) * 100)}%"></span>`}</span>
          <span class="num">${pct1(w)}</span>
        </td>
        <td>${pct1(p.put_away_pct)}</td>
        <td>${pct1(p.k_pct)}</td>
        <td>${p.ba != null ? avg3(p.ba) : NA}</td>
        <td>${p.est_ba != null ? avg3(p.est_ba) : NA}</td>
        <td>${int(p.pa)}</td>
      </tr>`;
  }).join("");
  return `
    <div class="table-scroll">
      <table class="dt ars">
        <caption class="sr-only">Pitch arsenal, most used first. Usage is the share of all pitches; whiff rate is misses per swing.</caption>
        <thead>
          <tr>
            <th scope="col" class="ars-name"><span title="Pitch type, and its share of all his pitches this season">Pitch and usage</span></th>
            ${hasPlatoon ? `<th scope="col" class="ars-plat"><span title="Share of his pitches to left-handed hitters that are this pitch">vs LHH</span></th><th scope="col" class="ars-plat"><span title="Share of his pitches to right-handed hitters that are this pitch">vs RHH</span></th>` : ""}
            <th scope="col" class="ars-whiff"><span title="Swinging strikes per swing on this pitch">Whiff%</span></th>
            <th scope="col"><span title="Two-strike pitches that ended in a strikeout">Put away%</span></th>
            <th scope="col">K%</th>
            <th scope="col">BA</th>
            <th scope="col">xBA</th>
            <th scope="col">PA</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="viz-note">Bar length is only ever share of all his pitches. ${hasPlatoon ? "vs LHH / vs RHH are the same share within pitches to each side, as numbers. " : ""}The whiff dot sits on its own 0 to ${WHIFF_MAX}% scale (misses per swing). Season, via Baseball Savant.</p>`;
}

// Short names for tight spaces (mix strips); full names everywhere else.
export const SHORT = { FF: "4-Seam", SI: "Sinker", SL: "Slider", CH: "Change", CU: "Curve", KC: "K-Curve", FC: "Cutter", ST: "Sweeper", FS: "Splitter", SV: "Slurve", FO: "Fork", KN: "Knuckle", CS: "Slow curve", EP: "Eephus", SC: "Screw" };
const pitchName = (p) => p.pitch_name || p.pitch_type;
const shortName = (t, fallback) => SHORT[t] || fallback || t;
// A tonal ramp from chrome to deep violet: pitches are told apart by tone and
// label, never by the outcome colors or the gold signal.
export const TONES = ["#e8edf6", "#b99af0", "#7f5cc9", "#5a3a9c", "#3f2872", "#2d1c52"];
export const INK = ["#140a22", "#140a22", "#ffffff", "#f3f0fb", "#f3f0fb", "#f3f0fb"];

/**
 * PITCH MATCHUP. What he throws against what this lineup misses. For every
 * pitch he throws at least 3% of the time: his whiff% on it next to the
 * opposing hitters' whiff% against that pitch type (their season, against
 * every pitcher). Same measure, same denominator (swings), one shared scale.
 * The key pitch is the one this lineup misses most among those he uses at
 * least 5% of the time.
 */
export function pitchDuel(arsenal, teamSplits, { oppAbbr, lastName }) {
  if (!arsenal?.length) return `<div class="state-inline">No pitch arsenal data for this pitcher yet.</div>`;
  const byType = new Map((teamSplits || []).map((s) => [s.pitch_type, s]));
  const rows = arsenal.filter((p) => (p.usage_pct || 0) >= 3).map((p) => ({ p, s: byType.get(p.pitch_type) }));
  if (!rows.some((r) => r.s?.whiff_pct != null)) return `<div class="state-inline">No ${esc(oppAbbr)} pitch-type splits available.</div>`;
  const vals = rows.flatMap((r) => [r.p.whiff_pct, r.s?.whiff_pct]).filter((v) => v != null);
  const max = Math.max(40, Math.ceil(Math.max(...vals) / 10) * 10);
  const x = (v) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  const key = [...rows].filter((r) => (r.p.usage_pct || 0) >= 5 && r.p.whiff_pct != null && r.s?.whiff_pct != null)
    .sort((a, b) => b.s.whiff_pct - a.s.whiff_pct)[0] || rows[0];
  const bar = (who, label, v, cls) => `
    <div class="duel-bar ${cls}">
      <span class="duel-who"><b>${esc(who)}</b><i>${label}</i></span>
      <b class="duel-v num">${v == null ? NA : `${v.toFixed(1)}<small>%</small>`}</b>
      <span class="duel-track">${v == null ? "" : `<span class="duel-fill" style="width:${x(v)}"></span>`}</span>
    </div>`;
  const block = (r, isKey) => `
    <div class="duel ${isKey ? "duel-key" : ""}" role="group" aria-label="${esc(pitchName(r.p))}: ${esc(lastName)} whiff ${r.p.whiff_pct != null ? r.p.whiff_pct.toFixed(1) + "%" : "not available"}, ${esc(oppAbbr)} hitters whiff ${r.s?.whiff_pct != null ? r.s.whiff_pct.toFixed(1) + "%" : "not available"} against this pitch type">
      <div class="duel-name">
        ${isKey ? `<span class="duel-kick">Key pitch</span>` : ""}
        <b>${esc(pitchName(r.p))}</b>
        <small class="num">${r.p.usage_pct != null ? `${r.p.usage_pct.toFixed(1)}% of his pitches` : "usage not available"}</small>
      </div>
      <div class="duel-bars">
        ${bar(lastName, "whiff", r.p.whiff_pct, "him")}
        ${bar(oppAbbr, "hitters' whiff", r.s?.whiff_pct, "opp")}
      </div>
    </div>`;
  const ticks = [];
  for (let t = 0; t <= max; t += 10) ticks.push(t);
  return `
    <div class="duels">
      ${block(key, true)}
      ${rows.filter((r) => r !== key).map((r) => block(r, false)).join("")}
      <div class="duel-axis" aria-hidden="true"><span></span><span></span><span class="duel-ticks">${ticks.map((t) => `<i style="left:${x(t)}">${t}${t === max ? "%" : ""}</i>`).join("")}</span></div>
    </div>
    <p class="viz-note">Whiff% is misses per swing, on one shared scale. ${esc(lastName)}: his 2026 whiff rate on the pitch. ${esc(oppAbbr)}: ${esc(oppAbbr)} hitters' 2026 whiff rate against that pitch type, from every pitcher they faced, not against him.</p>
    <details class="disclose">
      <summary>${icon("caret-right")}How ${esc(oppAbbr)} hits each of his pitch types</summary>
      <div class="disclose-body">
        <div class="table-scroll"><table class="dt">
          <thead><tr><th scope="col">Pitch type</th><th scope="col">His usage</th><th scope="col">${esc(oppAbbr)} PA</th><th scope="col">${esc(oppAbbr)} xBA</th><th scope="col">${esc(oppAbbr)} xwOBA</th><th scope="col">${esc(oppAbbr)} K%</th><th scope="col">${esc(oppAbbr)} Hard%</th></tr></thead>
          <tbody>${rows.map(({ p, s }) => `<tr><td class="txt">${esc(pitchName(p))}</td><td>${pct1(p.usage_pct)}</td><td>${s?.pa ?? NA}</td><td>${s?.est_ba != null ? avg3(s.est_ba) : NA}</td><td>${s?.est_woba != null ? avg3(s.est_woba) : NA}</td><td>${pct1(s?.k_pct)}</td><td>${pct1(s?.hard_hit_pct)}</td></tr>`).join("")}</tbody>
        </table></div>
      </div>
    </details>`;
}

/**
 * ARSENAL as one pitch system.
 *   WHAT HE THROWS   the season mix as one continuous 100% band: a pitch's
 *                    share of all his pitches is its slice's WIDTH.
 *   WHAT MISSES BATS hanging from each slice, a stem of fixed width whose
 *                    LENGTH is that pitch's whiff% (misses per swing) on one
 *                    shared 0 to 50% scale.
 * Width and length never trade places, so usage and whiff are never read on
 * the same dimension. The mix to each batter side follows as thinner bands in
 * the same order, where the splits exist. The pitch that misses the most bats
 * (among pitches he uses at least 5% of the time) is marked.
 */
export function arsenalSystem(arsenal, platoon) {
  if (!arsenal?.length) return `<div class="state-inline">No arsenal data available.</div>`;
  const order = arsenal.map((p) => p.pitch_type);
  const names = new Map(arsenal.map((p) => [p.pitch_type, pitchName(p)]));
  const toneOf = (t) => { const i = order.indexOf(t); return i < 0 ? TONES.length - 1 : Math.min(i, TONES.length - 1); };
  const style = (t, v) => { const i = toneOf(t); return `flex-basis:${v}%;--tone:${TONES[i]};--ink:${INK[i]}`; };
  const key = [...arsenal].filter((p) => p.whiff_pct != null && (p.usage_pct || 0) >= 5).sort((a, b) => b.whiff_pct - a.whiff_pct)[0];
  const main = arsenal.filter((p) => (p.usage_pct || 0) > 0);
  const unknownUse = arsenal.filter((p) => !(p.usage_pct > 0));
  const total = arsenal.reduce((s, p) => s + (p.pitches || 0), 0);
  // Pitch names grow with usage, so the band reads as his mix at a glance.
  const fs = (u) => Math.round(Math.min(40, Math.max(13, 11 + u * 0.7)));
  const band = main.map((p) => `
    <span class="am-seg ${p === key ? "key" : ""}" style="${style(p.pitch_type, p.usage_pct)};--fs:${fs(p.usage_pct)}px" title="${esc(pitchName(p))}: ${p.usage_pct.toFixed(1)}% of his pitches">
      <b>${esc(shortName(p.pitch_type, pitchName(p)))}</b><i class="num">${p.usage_pct.toFixed(1)}%</i>
    </span>`).join("");
  const stems = main.map((p) => {
    const w = p.whiff_pct;
    return `
    <span class="am-col ${p === key ? "key" : ""}" style="${style(p.pitch_type, p.usage_pct)}">
      ${w == null ? `<b class="am-wv none">n/a</b>` : `
      <span class="am-stem" style="height:${Math.min(100, (w / WHIFF_SCALE) * 100).toFixed(1)}%">
        <b class="am-wv">${w.toFixed(1)}<small>%</small></b>
        ${p === key ? `<i class="am-tag">Most whiffs</i>` : ""}
      </span>`}
    </span>`;
  }).join("");
  const side = (label, part) => {
    const segs = [...part.m].filter(([, v]) => v != null && v > 0).sort((a, b) => toneOf(a[0]) - toneOf(b[0]));
    return `
      <div class="am-row am-side">
        <div class="am-l"><b>${label}</b><small class="num">${part.total.toLocaleString()} pitches</small></div>
        <div class="am-band thin" role="img" aria-label="${esc(label)}: ${segs.map(([t, v]) => `${names.get(t) || t} ${v.toFixed(1)}%`).join(", ")}">
          ${segs.map(([t, v]) => `<span class="am-seg" style="${style(t, v)}" title="${esc(names.get(t) || t)} ${v.toFixed(1)}%"><b>${esc(shortName(t, names.get(t)))}</b><i class="num">${v.toFixed(1)}</i></span>`).join("")}
        </div>
      </div>`;
  };
  const hasPlatoon = platoon && (platoon.L.total || platoon.R.total);
  const ticks = [10, 20, 30, 40, 50];
  return `
    <div class="am">
      <div class="am-row">
        <div class="am-l"><b>What he throws</b><small class="num">Season${total ? `, ${total.toLocaleString()} pitches` : ""}</small></div>
        <div class="am-band" role="img" aria-label="Season pitch mix: ${main.map((p) => `${pitchName(p)} ${p.usage_pct.toFixed(1)}%`).join(", ")}">${band}</div>
      </div>
      <div class="am-row am-whiffs">
        <div class="am-l"><b>What misses bats</b><small>Whiff%, misses per swing, 0 to ${WHIFF_SCALE}%</small></div>
        <div class="am-field">
          <span class="am-grid" aria-hidden="true">${ticks.map((t) => `<i style="top:${(t / WHIFF_SCALE) * 100}%">${t}%</i>`).join("")}</span>
          <div class="am-cols" role="img" aria-label="Whiff rate by pitch, on a 0 to ${WHIFF_SCALE}% scale: ${main.map((p) => `${pitchName(p)} ${p.whiff_pct != null ? p.whiff_pct.toFixed(1) + "%" : "not available"}`).join(", ")}${key ? `. The ${pitchName(key).toLowerCase()} misses the most bats.` : ""}">${stems}</div>
        </div>
      </div>
      ${hasPlatoon ? side("vs LHH", platoon.L) + side("vs RHH", platoon.R) : ""}
      <div class="am-legend">${arsenal.map((p) => `<span><i style="--tone:${TONES[toneOf(p.pitch_type)]}"></i>${esc(pitchName(p))}${p.usage_pct > 0 ? "" : " (usage not available)"}</span>`).join("")}</div>
      ${unknownUse.length ? `<p class="viz-note">${unknownUse.map((p) => esc(pitchName(p))).join(", ")}: usage not available, so ${unknownUse.length === 1 ? "it is" : "they are"} left out of the mix band.</p>` : ""}
    </div>`;
}
const WHIFF_SCALE = 50;

/** The biggest change in his mix between left- and right-handed hitters, from real pitch counts. */
export function platoonFact(arsenal, platoon) {
  if (!platoon || !platoon.L.total || !platoon.R.total) return "";
  let best = null;
  arsenal.forEach((p) => {
    const l = platoon.L.m.get(p.pitch_type), r = platoon.R.m.get(p.pitch_type);
    if (l == null || r == null) return;
    const d = Math.abs(l - r);
    if (!best || d > best.d) best = { p, l, r, d };
  });
  if (!best || best.d < 8) return "";
  return `His mix changes by batter side: the ${pitchName(best.p).toLowerCase()} is ${best.l.toFixed(1)}% of his pitches to lefties and ${best.r.toFixed(1)}% to righties.`;
}
