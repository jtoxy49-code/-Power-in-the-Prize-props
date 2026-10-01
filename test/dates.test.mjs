// Tests for the shared MLB slate-date convention (public/assets/js/dates.js):
// US Eastern calendar date, rolling over at 5:00 AM Eastern, DST-aware.
// Run with: node --test test/dates.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { slateDate, slateDateOf, gameSlateDate, relSlateDay, addDays, validYmd, formatSlateDay, slateWeekday } from "../public/assets/js/dates.js";

// Instants written in UTC. Sep 30 2026 is daylight time: Eastern = UTC-4.
const ET = (s) => new Date(s);

test("the slate does not advance at 8 PM Eastern (the old UTC rollover)", () => {
  assert.equal(slateDate(0, ET("2026-09-30T23:59:00Z")), "2026-09-30"); // 7:59 PM ET
  assert.equal(slateDate(0, ET("2026-10-01T00:01:00Z")), "2026-09-30"); // 8:01 PM ET (UTC already Oct 1)
  assert.equal(slateDate(0, ET("2026-10-01T03:59:00Z")), "2026-09-30"); // 11:59 PM ET
  assert.equal(slateDate(0, ET("2026-10-01T04:01:00Z")), "2026-09-30"); // 12:01 AM ET: late games still tonight
});

test("the baseball day rolls over at 5:00 AM Eastern", () => {
  assert.equal(slateDate(0, ET("2026-10-01T08:59:00Z")), "2026-09-30"); // 4:59 AM ET
  assert.equal(slateDate(0, ET("2026-10-01T09:01:00Z")), "2026-10-01"); // 5:01 AM ET
});

test("offsets give tomorrow and the days after, across months and years", () => {
  assert.deepEqual([0, 1, 2, 3].map((n) => slateDate(n, ET("2026-10-01T02:00:00Z"))), ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("daylight saving: spring forward (Mar 8 2026) and fall back (Nov 1 2026)", () => {
  // Spring forward: 2 AM EST -> 3 AM EDT. 4:30 AM EDT = 08:30Z is before 5 AM; 5:30 AM EDT = 09:30Z after.
  assert.equal(slateDate(0, ET("2026-03-08T08:30:00Z")), "2026-03-07");
  assert.equal(slateDate(0, ET("2026-03-08T09:30:00Z")), "2026-03-08");
  // The evening before, 8:01 PM EST = 01:01Z next day, still Mar 7.
  assert.equal(slateDate(0, ET("2026-03-08T01:01:00Z")), "2026-03-07");
  // Fall back: 2 AM EDT -> 1 AM EST. 4:30 AM EST = 09:30Z before 5 AM; 5:30 AM EST = 10:30Z after.
  assert.equal(slateDate(0, ET("2026-11-01T09:30:00Z")), "2026-10-31");
  assert.equal(slateDate(0, ET("2026-11-01T10:30:00Z")), "2026-11-01");
  // In standard time 8:01 PM EST is 01:01Z; still the same evening.
  assert.equal(slateDate(0, ET("2026-11-02T01:01:00Z")), "2026-11-01");
});

test("a game belongs to the baseball day of its first pitch", () => {
  assert.equal(gameSlateDate("2026-09-30T23:05:00Z"), "2026-09-30"); // 7:05 PM ET
  assert.equal(gameSlateDate("2026-10-01T02:10:00Z"), "2026-09-30"); // 10:10 PM ET (7:10 PT)
  assert.equal(gameSlateDate("2026-10-01T05:05:00Z"), "2026-09-30"); // 1:05 AM ET late start
  assert.equal(gameSlateDate(null), null);
  assert.equal(slateDateOf("not a date"), null);
});

test("Today / Tomorrow labels use baseball days, not the viewer's calendar", () => {
  const now = ET("2026-10-01T01:30:00Z"); // 9:30 PM ET Sep 30
  assert.equal(relSlateDay("2026-10-01T02:10:00Z", now), "Today"); // tonight's 10:10 PM ET game
  assert.equal(relSlateDay("2026-10-01T17:05:00Z", now), "Tomorrow"); // 1:05 PM ET Oct 1
  assert.equal(relSlateDay("2026-09-29T23:05:00Z", now), "Yesterday");
  assert.equal(relSlateDay("2026-10-03T17:05:00Z", now), "Sat, Oct 3");
});

test("formatting and URL dates", () => {
  assert.equal(formatSlateDay("2026-09-30"), "Wed, Sep 30");
  assert.equal(slateWeekday("2026-09-30"), "Wednesday");
  assert.equal(validYmd("2026-09-30"), "2026-09-30");
  assert.equal(validYmd("2026-13-40"), null);
  assert.equal(validYmd("2026-09-30&hydrate=x"), null);
  assert.equal(validYmd(null), null);
});
