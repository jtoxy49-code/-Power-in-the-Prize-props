// MLB SLATE DATES: the one date convention for the whole app, imported by the
// frontend and the Worker alike.
//
// A baseball day is the calendar date in US Eastern time (America/New_York,
// so daylight saving is handled by the platform's time-zone data), and it
// rolls over at 5:00 AM Eastern rather than at midnight. Late West Coast games
// (10 PM ET starts that end after midnight) stay on that night's slate, and
// nothing advances to tomorrow at 8 PM Eastern the way a UTC date did.
// A game belongs to the baseball day of its first pitch under the same rule.
// Clock times are still shown in the viewer's own time zone.

export const SLATE_TZ = "America/New_York";
export const ROLLOVER_HOUR = 5;

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: SLATE_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
const pad = (n) => String(n).padStart(2, "0");
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/** YYYY-MM-DD plus n calendar days (pure date arithmetic, no time zone). */
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/** Whole days from ymd a to ymd b. */
export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

/** The baseball day an instant falls in. */
export function slateDateOf(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(date.getTime())) return null;
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const ymd = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return Number(p.hour) < ROLLOVER_HOUR ? addDays(ymd, -1) : ymd;
}

/** Today's baseball day, or n days from it. */
export function slateDate(offsetDays = 0, now = new Date()) {
  return addDays(slateDateOf(now), offsetDays);
}

/** A game's baseball day from its first-pitch time. */
export const gameSlateDate = (iso) => (iso ? slateDateOf(iso) : null);

/** A plausible YYYY-MM-DD from a URL, or null. */
export const validYmd = (s) => (isYmd(s) && !isNaN(Date.parse(`${s}T12:00:00Z`)) ? s : null);

const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const noonUtc = (ymd) => new Date(`${ymd}T12:00:00Z`);

/** "Wed, Sep 30" for a baseball day. */
export const formatSlateDay = (ymd) => (ymd ? dayFmt.format(noonUtc(ymd)) : "");
/** "Wednesday" for a baseball day. */
export const slateWeekday = (ymd) => (ymd ? weekdayFmt.format(noonUtc(ymd)) : "");

/** "Today", "Tomorrow", "Yesterday" or "Wed, Sep 30": a game's baseball day against today's. */
export function relSlateDay(iso, now = new Date()) {
  const g = gameSlateDate(iso);
  if (!g) return "";
  const diff = daysBetween(slateDate(0, now), g);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return formatSlateDay(g);
}
