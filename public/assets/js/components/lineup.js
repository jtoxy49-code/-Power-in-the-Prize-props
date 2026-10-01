// Opposing lineup. Uses the posted batting order from /api/lineups when MLB
// has it. Before it posts, the original app's stand-in (the team's nine
// hitters with the most plate appearances) is kept, and labeled as that,
// never as a "confirmed" lineup.
import { api } from "../api.js";
import { esc, pct1, avg3, NA } from "../format.js";
import { weightedAvg, LEAGUE_AVG } from "../domain.js";
import { avatar } from "../ui.js";
import { icon } from "../icons.js";

export function buildLineup(teamBatters, teamSplits, posted) {
  const split = new Map((teamSplits?.batters || []).map((b) => [b.batter_id, b]));
  const pool = (teamBatters?.batters || []).filter((b) => b.season && b.season.pa > 0);
  const byId = new Map(pool.map((b) => [String(b.player_id), b]));
  const shape = (b, order, idFallback, nameFallback) => {
    const id = b?.player_id ?? idFallback;
    return {
      order, player_id: id, name: b?.name || nameFallback,
      pa: b?.season?.pa ?? null, hr: b?.season?.home_runs ?? null, ba: b?.season?.avg ?? null, obp: b?.season?.obp ?? null, slg: b?.season?.slg ?? null,
      k_pct: b?.season?.k_pct ?? null, bb_pct: b?.season?.bb_pct ?? null,
      whiff_pct: split.get(id)?.whiff_pct ?? split.get(String(id))?.whiff_pct ?? null,
      chase_pct: split.get(id)?.chase_pct ?? split.get(String(id))?.chase_pct ?? null,
    };
  };
  if (posted?.length) {
    return { confirmed: true, batters: posted.map((p, i) => shape(byId.get(String(p.id)), i + 1, p.id, p.name)) };
  }
  return {
    confirmed: false,
    batters: pool.sort((a, b) => b.season.pa - a.season.pa).slice(0, 9).map((b, i) => shape(b, i + 1)),
  };
}

export function productionSummary(teamBatters) {
  const b = (teamBatters?.batters || []).filter((x) => x.season && x.season.pa > 0);
  const w = (fn) => weightedAvg(b, fn, (x) => x.season.pa);
  const avg = w((x) => x.season.avg), slg = w((x) => x.season.slg);
  return {
    pa: b.reduce((s, x) => s + (x.season.pa || 0), 0),
    bb: w((x) => x.season.bb_pct), k: w((x) => x.season.k_pct), avg, obp: w((x) => x.season.obp), slg,
    iso: avg != null && slg != null ? slg - avg : null, woba: w((x) => x.expected?.woba),
  };
}

// The meter follows the prop being researched, and every meter has a real MLB
// reference value (LEAGUE_AVG), so the average tick is never invented.
const METERS = {
  strikeouts: { key: "k_pct", label: "K%", avg: LEAGUE_AVG.k_pct, floor: 40, pct: true },
  outs: { key: "k_pct", label: "K%", avg: LEAGUE_AVG.k_pct, floor: 40, pct: true },
  walks: { key: "bb_pct", label: "BB%", avg: LEAGUE_AVG.bb_pct, floor: 20, pct: true },
  hits_allowed: { key: "ba", label: "AVG", avg: LEAGUE_AVG.ba, floor: 0.35, pct: false },
  earned_runs: { key: "ba", label: "AVG", avg: LEAGUE_AVG.ba, floor: 0.35, pct: false },
};

/**
 * The opposing batting order, read the way a lineup card is: the team and its
 * finding on top, then the nine hitters in order, each with the stat the prop
 * is about built into the row as a bar against the MLB average. No box, no
 * table cells. No handedness or position is shown: the data doesn't carry them.
 * Posted order: solid numerals, rules after the 3rd and 6th hitters.
 * Not posted: outlined rank numerals and no batting-order rhythm, because the
 * list is ranked by plate appearances, not an order.
 */
export function lineupCard(lineup, { oppAbbr, pitcherName, statKey, summary }) {
  if (!lineup.batters.length) return `<div class="state-inline">No hitter data for this team yet.</div>`;
  const m = METERS[statKey] || METERS.strikeouts;
  const fmt = (v) => (v == null ? NA : m.pct ? `${v.toFixed(1)}%` : avg3(v));
  const vals = lineup.batters.map((b) => b[m.key]).filter((v) => v != null);
  const max = Math.max(m.floor, ...vals);
  const x = (v) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  const last = String(pitcherName).split(" ").slice(-1)[0];
  const teamVal = m.key === "k_pct" ? summary.k : m.key === "bb_pct" ? summary.bb : summary.avg;
  const rel = teamVal == null ? "" : teamVal > m.avg ? "above" : teamVal < m.avg ? "below" : "level with";
  const unitLabel = m.label; // K%, BB% or AVG
  return `
    <div class="lo ${lineup.confirmed ? "posted" : "ranked"}">
      <header class="lo-head">
        <div class="lo-team">
          <span class="lo-abbr">${esc(oppAbbr)}</span>
          <span class="lu-state ${lineup.confirmed ? "on" : ""}">${lineup.confirmed ? "Batting order posted" : "Lineup not posted"}</span>
        </div>
        <div class="lo-find">
          <span class="lo-find-v">${teamVal == null ? "-" : m.pct ? `${teamVal.toFixed(1)}<small>%</small>` : avg3(teamVal)}</span>
          <span class="lo-find-l"><b>Team ${unitLabel}</b>${rel ? `${rel} the ${fmt(m.avg)} MLB average` : ""}</span>
          <span class="lo-find-m" role="img" aria-label="Team ${unitLabel} ${fmt(teamVal)}, MLB average ${fmt(m.avg)}">${teamVal == null ? "" : `<span class="lo-fill" style="width:${x(teamVal)}"></span>`}<span class="lo-avg" style="left:${x(m.avg)}"></span></span>
        </div>
        <dl class="lo-team-line">
          ${[["AVG", avg3(summary.avg)], ["OBP", avg3(summary.obp)], ["SLG", avg3(summary.slg)], ["ISO", avg3(summary.iso)], ["K%", pct1(summary.k)], ["BB%", pct1(summary.bb)], ["PA", summary.pa ? summary.pa.toLocaleString() : NA]]
            .filter(([k]) => k !== m.label).map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join("")}
        </dl>
        <p class="lu-note">${lineup.confirmed
          ? "Posted by MLB. Every number is the hitter's 2026 season; whiff and chase are the last 60 days."
          : `Until MLB posts it, these are the nine ${esc(oppAbbr)} hitters with the most plate appearances, ranked by plate appearances, not a batting order.`}</p>
      </header>
      <p class="lo-key" aria-hidden="true"><span><i class="lo-key-bar"></i>${m.label}, 2026</span><span><i class="lo-key-avg"></i>MLB average ${fmt(m.avg)}</span><span>Whiff and chase: last 60 days</span></p>
      <ol class="lo-list">
        ${lineup.batters.map((b) => {
          const v = b[m.key];
          const above = v != null && v > m.avg;
          return `
          <li class="lo-slot ${above ? "above" : ""}" data-bid="${esc(b.player_id)}">
            <span class="lo-ord" aria-label="${lineup.confirmed ? `Batting ${b.order}` : `Rank ${b.order} by plate appearances`}">${b.order}</span>
            ${avatar(b.name, b.player_id, 56, "lo-face")}
            <b class="lo-name">${esc(b.name)}</b>
            <span class="lo-v"><b>${fmt(v)}</b><i>${m.label}</i></span>
            <span class="lo-bar" role="img" aria-label="${m.label} ${v == null ? "not available" : fmt(v).replace(/<[^>]+>/g, "")}, MLB average ${fmt(m.avg)}">${v == null ? "" : `<span class="lo-fill" style="width:${x(v)}"></span>`}<span class="lo-avg" style="left:${x(m.avg)}"></span></span>
            <div class="lo-meta num">
              <span>${b.pa != null ? `${b.pa} PA` : ""}${b.hr != null ? ` · ${b.hr} HR` : ""}</span>
              <span>${avg3(b.ba)}<i>/</i>${avg3(b.obp)}<i>/</i>${avg3(b.slg)}</span>
              <span><i>Whiff</i> ${pct1(b.whiff_pct)} <i>Chase</i> ${pct1(b.chase_pct)}</span>
            </div>
            <button class="lu-bvp-btn" type="button" data-bvp="${esc(b.player_id)}" data-name="${esc(b.name)}" aria-expanded="false" aria-controls="bvp-${esc(b.player_id)}">vs ${esc(last)}${icon("caret-down")}</button>
            <div class="lu-bvp" id="bvp-${esc(b.player_id)}" data-for="${esc(b.player_id)}" hidden></div>
          </li>`;
        }).join("")}
      </ol>
    </div>`;
}

export function wireBvp(container, pitcher) {
  const cache = new Map();
  container.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-bvp]");
    if (!btn) return;
    const id = btn.dataset.bvp;
    const row = container.querySelector(`.lu-bvp[data-for="${CSS.escape(id)}"]`);
    const open = row.hidden;
    row.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    btn.querySelector("svg")?.classList.toggle("flip", open);
    if (!open) return;
    const cell = row.querySelector("td") || row;
    if (!pitcher.player_id) { cell.innerHTML = `<div class="state-inline">Pitcher ID unavailable, so matchup history can't load.</div>`; return; }
    if (!cache.has(id)) {
      cell.innerHTML = `<div class="state-inline">Loading matchup history…</div>`;
      cache.set(id, api.batterVsPitcher(id, pitcher.player_id));
    }
    try {
      cell.innerHTML = bvpHtml(await cache.get(id), btn.dataset.name, pitcher.name);
    } catch {
      cache.delete(id);
      cell.innerHTML = `<div class="state-inline">Couldn't load matchup history. Close and reopen to retry.</div>`;
    }
  });
}

function bvpHtml(d, batter, pitcher) {
  if (!d || d.pa === 0) return `<div class="bvp"><p class="bvp-none">${esc(batter)} has no plate appearances against ${esc(pitcher)} in the last 3 seasons.</p></div>`;
  const pts = d.pitch_types || [];
  const stat = (l, v) => `<div class="kv"><span>${l}</span><b class="num">${v}</b></div>`;
  const t = (title, head, rows) => `
    <h5 class="bvp-h">${title}</h5>
    <div class="table-scroll"><table class="dt"><thead><tr>${head.map((h, i) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  return `
    <div class="bvp">
      <div class="bvp-top"><span class="bvp-title">${esc(batter)} vs ${esc(pitcher)}</span><span class="faint">Last 3 seasons</span></div>
      <div class="kv-row">${stat("PA", d.pa)}${stat("AB", d.ab)}${stat("H", d.hits)}${stat("BA", d.ba != null ? d.ba.toFixed(3) : "-")}${stat("K", d.strikeouts)}${stat("BB", d.walks)}${stat("HR", d.home_runs)}</div>
      ${pts.length ? `
        ${t(`Against his pitch mix`, ["Pitch", "Usage", "PA", "BA", "xBA", `<span title="Approximate: batted-ball-only average, not full plate-appearance-weighted wOBA">xwOBA*</span>`, "Hard%", "Whiff%", "K%", "BB%", `<span title="Approximate: sign convention not independently verified">RV/100*</span>`],
          pts.map((p) => `<tr><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${pct1(p.usage_pct)}</td><td>${p.pa}</td><td>${p.ba != null ? p.ba.toFixed(3) : NA}</td><td>${p.xba != null ? p.xba.toFixed(3) : NA}</td><td>${p.xwoba != null ? p.xwoba.toFixed(3) : NA}</td><td>${pct1(p.hard_hit_pct)}</td><td>${pct1(p.whiff_pct)}</td><td>${pct1(p.k_pct)}</td><td>${pct1(p.bb_pct)}</td><td>${p.rv_per_100 != null ? (p.rv_per_100 > 0 ? "+" : "") + p.rv_per_100 : NA}</td></tr>`).join(""))}
        ${t("Plate discipline vs each pitch", ["Pitch", "PA", "O-Swing%", "Z-Swing%", "Swing%", "O-Contact%", "Z-Contact%", "Contact%", "Zone%", "SwStr%"],
          pts.map((p) => { const x = p.plate_discipline || {}; return `<tr><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${x.pa ?? NA}</td><td>${pct1(x.o_swing_pct)}</td><td>${pct1(x.z_swing_pct)}</td><td>${pct1(x.swing_pct)}</td><td>${pct1(x.o_contact_pct)}</td><td>${pct1(x.z_contact_pct)}</td><td>${pct1(x.contact_pct)}</td><td>${pct1(x.zone_pct)}</td><td>${pct1(x.swstr_pct)}</td></tr>`; }).join(""))}
        ${t("Batted ball vs each pitch", ["Pitch", "PA", "LD%", "GB%", "FB%", "IFFB%", "HR/FB"],
          pts.map((p) => { const x = p.batted_ball || {}; return `<tr><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${x.pa ?? NA}</td><td>${pct1(x.ld_pct)}</td><td>${pct1(x.gb_pct)}</td><td>${pct1(x.fb_pct)}</td><td>${pct1(x.iffb_pct)}</td><td>${pct1(x.hr_per_fb_pct)}</td></tr>`; }).join(""))}
        <p class="viz-note">* Approximate values, labeled as they were in the original tool.</p>`
      : `<p class="faint">No pitch-level breakdown for this sample.</p>`}
    </div>`;
}

/** Team pitch-type splits (plate discipline or batted ball), with the summary row. */
export function teamSplitTable(pitchTypes, mode) {
  if (!pitchTypes?.length) return `<div class="state-inline">No data for this split.</div>`;
  const w = (fn, weight) => weightedAvg(pitchTypes, fn, weight);
  if (mode === "pd") {
    const byPitches = (p) => p.pitches;
    const k = (key) => w((p) => p.plate_discipline[key], byPitches);
    const cols = [["O-Swing%", "o_swing_pct"], ["Z-Swing%", "z_swing_pct"], ["Swing%", "swing_pct"], ["O-Contact%", "o_contact_pct"], ["Z-Contact%", "z_contact_pct"], ["Zone%", "zone_pct"], ["SwStr%", "swstr_pct"]];
    return splitTable(cols, pitchTypes, (p, key) => p.plate_discipline[key], (key) => k(key), ["Pitches", (p) => p.pitches]);
  }
  const byBip = (p) => p.batted_ball.balls_in_play;
  const cols = [["LD%", "ld_pct"], ["GB%", "gb_pct"], ["FB%", "fb_pct"], ["IFFB%", "iffb_pct"], ["HR/FB", "hr_per_fb_pct"]];
  return splitTable(cols, pitchTypes, (p, key) => p.batted_ball[key], (key) => w((p) => p.batted_ball[key], byBip), ["BIP", (p) => p.batted_ball.balls_in_play]);
}

// The sample column is shown so a 12-pitch forkball row is read as the tiny sample it is.
function splitTable(cols, rows, get, total, [sampleLabel, sample]) {
  const n = rows.reduce((s, p) => s + (sample(p) || 0), 0);
  return `
    <div class="table-scroll">
      <table class="dt">
        <thead><tr><th scope="col">Pitch</th><th scope="col">${sampleLabel}</th>${cols.map(([l]) => `<th scope="col">${l}</th>`).join("")}</tr></thead>
        <tbody>
          <tr class="row-total"><th scope="row" class="txt">All pitches</th><td>${n.toLocaleString()}</td>${cols.map(([, k]) => `<td>${pct1(total(k))}</td>`).join("")}</tr>
          ${rows.map((p) => `<tr class="${(sample(p) || 0) < 50 ? "thin" : ""}"><td class="txt">${esc(p.pitch_name || p.pitch_type)}</td><td>${(sample(p) ?? 0).toLocaleString()}</td>${cols.map(([, k]) => `<td>${pct1(get(p, k))}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="viz-note">Rows under 50 ${sampleLabel === "BIP" ? "balls in play" : "pitches"} are dimmed as small samples.</p>`;
}

export function productionTable(splits) {
  if (!splits?.length) return `<div class="state-inline">No data available.</div>`;
  return `
    <div class="table-scroll">
      <table class="dt">
        <thead><tr><th scope="col">Pitch type</th><th scope="col">PA</th><th scope="col">BA</th><th scope="col">xBA</th><th scope="col">xwOBA</th><th scope="col">Hard%</th><th scope="col">K%</th><th scope="col">BB%</th><th scope="col">Whiff%</th></tr></thead>
        <tbody>${splits.map((s) => `<tr><td class="txt">${esc(s.pitch_name || s.pitch_type)}</td><td>${s.pa}</td><td>${s.ba != null ? s.ba.toFixed(3) : NA}</td><td>${s.est_ba != null ? s.est_ba.toFixed(3) : NA}</td><td>${s.est_woba != null ? s.est_woba.toFixed(3) : NA}</td><td>${pct1(s.hard_hit_pct)}</td><td>${pct1(s.k_pct)}</td><td>${s.bb_pct != null ? pct1(s.bb_pct) : '<span class="na" title="Walks are not attributable to one pitch type in this data source">N/A</span>'}</td><td>${pct1(s.whiff_pct)}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;
}
