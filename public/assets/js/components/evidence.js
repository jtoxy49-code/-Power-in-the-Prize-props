// SAME-HANDED STARTERS, read as historical evidence: how starters of his hand
// actually did against this team. The result is stated first, as four large
// anchors on an open band; the dated starts sit underneath as the evidence.
// Real game lines only. When the section's stat is the prop's stat, each
// start is also marked against his line as a reference point.
import { esc, NA, dateShort, line as fmtLine } from "../format.js";
import { statOf, isHit } from "../domain.js";
import { avatar } from "../ui.js";

const VENUE = { at_opponent_park: (opp) => `at ${opp}`, at_starter_home_park: () => "at his park" };

export function evidenceSummary(rows, { key, line, selection, pitcherName }) {
  const vals = rows.map((p) => statOf(p, key)).filter((v) => v != null);
  const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  const over = line != null ? vals.filter((v) => isHit(v, line, selection)).length : null;
  const his = rows.filter((p) => p.pitcher_name === pitcherName).length;
  return { n: vals.length, mean, over, his };
}

export function evidenceLedger(rows, { key, label, line, selection, pitcherName, hp, oppAbbr }) {
  if (!rows.length) return `<div class="state-inline">No recent ${esc(hp)} starts found in this split.</div>`;
  const s = evidenceSummary(rows, { key, line, selection, pitcherName });
  const side = selection === "Under" ? "under" : "over";
  const cell = (v, k) => (v == null ? NA : `${v} ${k}`);
  // One cell per start, newest first, in the same order as the ledger below.
  const strip = line == null ? "" : `
    <dd class="ev-tally-dd"><span class="tally ev-tally" role="img" aria-label="${s.over} of ${s.n} went ${side} ${esc(fmtLine(line))}, newest start first">
      ${rows.map((p) => {
        const v = statOf(p, key);
        const m = v == null ? "x" : isHit(v, line, selection) ? "h" : "m";
        return `<i class="${m}" title="${esc(dateShort(p.date))}, ${esc(p.pitcher_name)}: ${v ?? "no data"}"></i>`;
      }).join("")}
    </span></dd>`;
  return `
    <div class="ev">
      <dl class="ev-band">
        <div class="ev-a"><dt>${esc(hp)} starts vs ${esc(oppAbbr)}</dt><dd>${s.n}</dd></div>
        <div class="ev-a ev-lead"><dt>${esc(label)} per start</dt><dd>${s.mean != null ? s.mean.toFixed(1) : "-"}</dd></div>
        ${s.over != null ? `<div class="ev-a"><dt>Went ${side} ${esc(fmtLine(line))}</dt><dd>${s.over}<small>/${s.n}</small></dd>${strip}</div>` : ""}
        ${s.his ? `<div class="ev-a"><dt>By ${esc(pitcherName.split(" ").slice(-1)[0])} himself</dt><dd>${s.his}</dd></div>` : ""}
      </dl>
      <ol class="ev-list" aria-label="Each start, newest first">
        ${rows.map((p) => {
          const v = statOf(p, key);
          const mark = line == null || v == null ? "" : isHit(v, line, selection) ? "h" : "m";
          const him = p.pitcher_name === pitcherName;
          return `
          <li class="ev-row ${him ? "him" : ""}">
            <span class="ev-date">${p.date ? esc(dateShort(p.date)) : NA}</span>
            <span class="ev-who">${avatar(p.pitcher_name, p.pitcher_id, 32, "ev-face")}<span><b>${esc(p.pitcher_name)}</b>${him ? '<span class="tag">This pitcher</span>' : ""}<small>${esc((VENUE[p.venue_relation] || (() => ""))(oppAbbr))}</small></span></span>
            <span class="ev-res" aria-label="${v == null ? `No recorded ${esc(label)}` : `${v} ${esc(label)}${mark ? `, ${mark === "h" ? "went" : "did not go"} ${side} ${esc(fmtLine(line))}` : ""}`}"><b>${v ?? "-"}</b><small>${esc(label)}</small>${mark ? `<i class="ev-mark ${mark}" aria-hidden="true"></i>` : ""}</span>
            <span class="ev-line num">${esc(p.innings_pitched ?? "-")} IP · ${key === "strikeouts" ? "" : `${cell(p.strikeouts, "K")} · `}${key === "hits_allowed" ? "" : `${cell(p.hits_allowed, "H")} · `}${key === "earned_runs" ? "" : `${cell(p.earned_runs, "ER")} · `}${key === "walks" ? "" : `${cell(p.walks, "BB")} · `}${cell(p.pitches_thrown, "P")}</span>
          </li>`;
        }).join("")}
      </ol>
      ${line != null ? `<p class="viz-note">The ${side} mark measures each start against his line (${esc(fmtLine(line))}) as a reference; those pitchers were not priced at it.</p>` : ""}
    </div>`;
}
