import { relSlateDay } from "./dates.js";
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Missing values render as a muted hyphen with an accessible name.
export const NA = '<span class="na" aria-label="no data">-</span>';

export const odds = (v) => (v == null ? NA : v > 0 ? `+${v}` : `${v}`);
export const oddsText = (v) => (v == null ? "no price" : v > 0 ? `+${v}` : `${v}`);
export const pct1 = (v) => (v == null ? NA : `${Number(v).toFixed(1)}%`);
export const pct0 = (v) => (v == null ? NA : `${Math.round(v)}%`);
export const avg3 = (v) => (v == null ? NA : Number(v).toFixed(3).replace(/^0/, ""));
export const fix1 = (v) => (v == null ? NA : Number(v).toFixed(1));
export const fix2 = (v) => (v == null ? NA : Number(v).toFixed(2));
export const int = (v) => (v == null ? NA : `${v}`);

// American odds -> implied probability (standard conversion; display only).
export function implied(american) {
  if (american == null) return null;
  return american < 0 ? (-american / (-american + 100)) * 100 : (100 / (american + 100)) * 100;
}

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const tzFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });
const longDayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const valid = (iso) => iso && !isNaN(new Date(iso).getTime());
// Clock times never break before AM/PM.
export const time = (iso) => (valid(iso) ? timeFmt.format(new Date(iso)).replace(/\s(?=[AP]M)/, " ") : "");
export const timeTz = (iso) => (valid(iso) ? tzFmt.format(new Date(iso)) : "");
export const day = (iso) => (valid(iso) ? dayFmt.format(new Date(iso)) : "");
export const longDay = (d) => longDayFmt.format(d);
export const dateShort = (ymd) => (ymd ? shortDate.format(new Date(`${ymd}T12:00:00`)) : "");

/** "Today", "Tomorrow", or "Wed, Sep 30": a game's baseball day (dates.js) against today's. */
export const relDay = (iso) => (valid(iso) ? relSlateDay(iso) : "");

/** "6 min ago", "2 hr ago" for data freshness. */
export function ago(iso) {
  if (!valid(iso)) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return dayFmt.format(new Date(iso));
}

export const line = (v) => (v == null ? "" : Number(v) % 1 === 0 ? Number(v).toFixed(0) : String(Number(v)));
