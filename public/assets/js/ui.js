// Shared markup helpers. Views compose these; none of them fetch data.
import { esc, odds, line as fmtLine } from "./format.js";
import { headshot, initialsFor, bookLabel, MARKET_TO_STATKEY, marketLabel } from "./domain.js";
import { icon } from "./icons.js";

/** Headshot with an initials fallback that never leaves a broken image. */
export function avatar(name, id, size = 40, cls = "") {
  const initials = esc(initialsFor(name));
  const img = id
    ? `<img src="${headshot(id, size * 2)}" width="${size}" height="${size}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`
    : "";
  return `<span class="face ${cls}" style="--size:${size}px" aria-hidden="true"><span class="face-init">${initials}</span>${img}</span>`;
}

/** Link to the pitcher page. Keeps the original share-link parameter names. */
export function pitcherHref({ name, market, line, selection, opponent, home_team, game_time, matchup, sample, team }) {
  const p = new URLSearchParams();
  p.set("pitcher", name);
  if (matchup) p.set("matchup", matchup);
  if (market) p.set("market", `${marketLabel(market)} · ${selection} ${fmtLine(line)}`);
  if (line != null) p.set("line", String(line));
  if (selection) p.set("selection", selection);
  if (market) p.set("statKey", MARKET_TO_STATKEY[market] || "strikeouts");
  if (opponent) p.set("opponent", opponent);
  if (home_team) p.set("home_team", home_team);
  if (game_time) p.set("game_time", game_time);
  if (team) p.set("team", team);
  if (sample) p.set("sample", sample);
  return `/?${p.toString()}`;
}

export function priceCell(best, side) {
  if (!best) return `<span class="price price-none" aria-label="No ${side} price">-</span>`;
  return `<span class="price"><span class="num">${odds(best.odds)}</span><span class="book">${esc(bookLabel(best.book))}</span></span>`;
}

export function skeletonRows(n, cls = "sk-row") {
  return Array.from({ length: n }, () => `<div class="${cls}"><span class="skeleton"></span></div>`).join("");
}

export function errorState(title, detail, retryId) {
  return `<div class="state" role="alert"><strong>${esc(title)}</strong><span>${esc(detail)}</span>${
    retryId ? `<button class="btn btn-quiet" id="${retryId}" type="button">${icon("arrows-clockwise")}Try again</button>` : ""
  }</div>`;
}
