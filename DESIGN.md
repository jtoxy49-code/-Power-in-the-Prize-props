---
name: PWR Props
description: PWR Premium's pitcher-prop research product in the PWR Lab language, from the day's slate to the market board to a pitcher's scouting report.
colors:
  ink-deep: "#07040c"
  ink-recess: "#08040e"
  ink-0: "#0b0612"
  ink-side: "#12071f"
  ink-1: "#140a22"
  ink-2: "#1b0f2e"
  ink-3: "#26143f"
  purple-deep: "#16032b"
  purple-shadow: "#280a46"
  purple: "#43186a"
  ticket-plum: "#2a0d4a"
  violet: "#5d21b8"
  violet-edge: "rgba(185, 154, 240, 0.2)"
  purple-light: "#b99af0"
  line: "rgba(232, 237, 246, 0.08)"
  line-strong: "rgba(232, 237, 246, 0.15)"
  text: "#e8edf6"
  text-2: "#aab3c7"
  text-3: "#8f98ae"
  text-disabled: "#5d6478"
  gold: "#d9a441"
  gold-strong: "#eabb57"
  gold-ink: "#1a1408"
  gold-wash: "rgba(217, 164, 65, 0.12)"
  gold-line: "rgba(217, 164, 65, 0.45)"
  hit: "#5cc27a"
  miss: "#a44a5a"
  pos: "#5cc27a"
  neg: "#e8848c"
  hit-wash: "rgba(92, 194, 122, 0.12)"
  warn: "#e3a857"
  no-line: "#7d86a3"
  chrome-bar: "#b9c2d6"
  chrome-bar-low: "#6f7891"
  pitch-tone-1: "#e8edf6"
  pitch-tone-2: "#b99af0"
  pitch-tone-3: "#7f5cc9"
  pitch-tone-4: "#5a3a9c"
  pitch-tone-5: "#3f2872"
  pitch-tone-6: "#2d1c52"
typography:
  name-hero:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "clamp(56px, calc(100cqw / (var(--len) * 0.5)), 156px)"
    fontWeight: 800
    lineHeight: 0.8
    letterSpacing: "-0.005em"
  line-hero:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "124px"
    fontWeight: 800
    lineHeight: 0.78
    letterSpacing: "-0.01em"
  result-hero:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "118px"
    fontWeight: 800
    lineHeight: 0.76
    letterSpacing: "-0.015em"
  page-title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "76px"
    fontWeight: 800
    lineHeight: 0.8
    letterSpacing: "0.005em"
  board-title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "60px"
    fontWeight: 800
    lineHeight: 0.82
    letterSpacing: "0.005em"
  chapter-title:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "46px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.005em"
  slate-clock:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "42px"
    fontWeight: 800
    lineHeight: 0.82
    fontFeature: "\"tnum\""
  slate-teams:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "34px"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "0.03em"
  game-band:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "0.03em"
  line-figure:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "30px"
    fontWeight: 800
    lineHeight: 1
  pitcher-name:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "25px"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "0.01em"
  finding:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.25
  caption:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.08em"
  body:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.3
  odds:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "20px"
    fontWeight: 600
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\""
  data:
    fontFamily: "IBM Plex Mono, ui-monospace, Cascadia Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    letterSpacing: "-0.01em"
    fontFeature: "\"tnum\""
rounded:
  data: "2px"
  float: "10px"
  sheet: "14px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s7: "32px"
  s8: "40px"
  s9: "48px"
  page-x: "clamp(16px, 3vw, 40px)"
  prop-indent: "62px"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.gold-ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.data}"
    padding: "0 18px"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.gold-strong}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.data}"
    padding: "0 14px"
    height: "40px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.data}"
    padding: "0 10px"
    height: "40px"
  segment:
    backgroundColor: "{colors.ink-recess}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.data}"
    padding: "0 12px"
    height: "34px"
  segment-selected:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.text}"
  prop-chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.data}"
    padding: "0 12px"
    height: "36px"
  prop-chip-pressed:
    backgroundColor: "rgba(232, 237, 246, 0.08)"
    textColor: "{colors.text}"
  filter-token:
    backgroundColor: "{colors.ink-3}"
    textColor: "{colors.text}"
    rounded: "{rounded.data}"
    padding: "0 8px 0 10px"
    height: "30px"
  search-input:
    backgroundColor: "{colors.ink-recess}"
    textColor: "{colors.text}"
    rounded: "{rounded.data}"
    padding: "0 12px 0 38px"
    height: "40px"
  price-cell:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.odds}"
    rounded: "{rounded.data}"
    padding: "4px 10px"
    height: "48px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.data}"
    padding: "0 10px"
    height: "44px"
  nav-item-active:
    backgroundColor: "rgba(232, 237, 246, 0.07)"
    textColor: "{colors.text}"
  sticky-pitcher:
    backgroundColor: "{colors.ink-0}"
    textColor: "{colors.text}"
    typography: "{typography.pitcher-name}"
    height: "46px"
---

# Design System: PWR Props

## Overview

**Creative North Star: "PWR Lab"**

PWR Props is one system across three surfaces with three jobs. Home is the slate: which games are coming, who starts, what the books have posted, where to begin. The Board is the market terminal: every posted line with its best prices and how the pitcher has done against it, built to be scanned. Player Detail is the scouting report: the athlete, the ticket, the result on its bracket, then chapters that each answer one question. The hierarchy between them is deliberate: slate and discovery, then the market, then the athlete.

The Lab language is open composition on a near-black purple ground. Sections open on a hard rule with a short chrome tab instead of sitting in panels. Names, matchups and the numbers that matter are set big in Barlow Condensed capitals; everything you operate is Inter; measured prices and stats are Plex Mono. Gold is rationed to the line, the selection, the primary action and the row you are on. The 22 degree Strike from the PWR bolt marks where you are and cuts the athlete's portrait, and nothing else.

Photography belongs to Player Detail, the one athlete-driven screen. Home and the Board are sports-first and data-first: real MLB headshots at list size, team abbreviations instead of logos, and no imagery added for atmosphere. Motion is product-speed state change on one curve.

**Key Characteristics:**
- Dark only: logo purples pushed to black as ground, chrome text in three steps, one rationed gold.
- Open compositions: a hard rule plus a 56 by 5px chrome tab opens every chapter, day and game.
- Barlow Condensed for names, matchups and headline figures; Inter for UI; Plex Mono for prices and measured stats.
- Gold means the line, the selection, the primary action, or the row you're on. Utilities and statuses are never gold.
- The 22 degree Strike on the portrait cut and on vertical "you are here" markers only.
- Outcomes never by color alone: hits solid, misses hatched, missing values outlined or labeled, never shown as 0.

## Colors

A near-black purple ground in tonal steps, cool chrome text, one gold signal, a validated hit/miss pair for outcomes, and a chrome-to-violet ramp that tells pitches apart.

### Primary
- **Rationed Gold** (gold, #d9a441): the prop line (the ticket's 124px line, the chart's 2px line rule, the gold bracket), the current selection (segment underlines, the pressed prop chip's underline, the selected side on the ticket, sample tabs, the Main lines switch when on, the active-filter count badge), the primary action ("Open the board", "Show lines"), the Strike blade on the row or starter under the pointer or focus, the active nav blade, focus rings and text selection. **Gold Strong** (#eabb57) is hover and gold text on a wash; **Gold Ink** (#1a1408) is text on a gold fill; **Gold Wash** and **Gold Line** are the fill and hairline of gold-selected states.

### Secondary
- **Logo Purples** (purple-deep #16032b, purple-shadow #280a46, purple #43186a): depth, never text. Purple Shadow fills headshot wells; the portrait field and the ticket are purple.
- **Ticket Plum** (ticket-plum, #2a0d4a): the top of the ticket's gradient to #170630, with a Violet Edge border and a brighter top edge.
- **Violet** (violet, #5d21b8): light, not paint. It lifts the selected sample window on the game-log chart and edges the ticket. In the Lineup Matchups matrix it is the pitcher's-edge wash (30% and 62% over Night), paired with a chrome wash (8% and 17%) for the hitter's edge.
- **Lilac** (purple-light, #b99af0): headshot initials when no photo is on file, and the live game status on Home.

### Tertiary (outcome)
- **Went-Over Green** (hit, #5cc27a): a result that cleared the line: solid chart bars, solid trend cells, a good hit rate. Also positive text (pos): lineup posted, best price in the books table.
- **Did-Not Wine** (miss, #a44a5a): a result that fell short, always drawn with a 135 degree hatch and an inset outline, never a plain fill. Validated against hit at deutan dE 20.2 on the chart surface.
- **Soft Red** (neg, #e8848c): miss and worse-than-average text where wine is too dark to read.
- **No-Line Slate** (no-line, #7d86a3): a start plotted when no line was posted, so there is nothing to hit or miss.
- **Caution Amber** (warn, #e3a857): a genuine caution only, such as a starter a sportsbook has posted but MLB has not confirmed. Never game status, never an outcome.

### Neutral
- **Surfaces, darkest to lightest:** Stage (ink-deep, #07040c) under the portrait and behind the Board's sticky filter bar; Recess (ink-recess, #08040e) for chart wells, inputs, segment trays and opened book rows; Night (ink-0, #0b0612) the app background, also the sticky column header and sticky pitcher strip; Sidebar Ink (ink-side, #12071f) for the sidebar, phone top bar and tab bar; Panel Ink (ink-1, #140a22) for the phone filter sheet; Hover Ink (ink-2, #1b0f2e) for popovers and menus; Control Ink (ink-3, #26143f) for control fills, selected segments and filter tokens.
- **Chrome text:** text (#e8edf6, 16.3:1), text-2 (#aab3c7, 9.1:1), text-3 (#8f98ae, 6.6:1) on ink-1. text-disabled (#5d6478) for N/A cells, outlined no-data cells and disabled nav only.
- **Hairlines:** line (8% chrome) between rows, line-strong (15% chrome) for section rules, sticky edges and control outlines.
- **Chart Chrome:** chrome-bar (#b9c2d6) and chrome-bar-low (#6f7891) for arsenal-table share bars, lineup stat bars and park-factor bars. Chrome, not a data-series color.
- **Pitch Tones** (pitch-tone-1 to 6, #e8edf6 to #2d1c52): a chrome-to-deep-violet ramp assigned by usage rank; pitches are told apart by tone and label.

### Named Rules
**The Rationed Gold Rule.** Gold is the line, the selection, the primary action and the row you're on. Utility actions (Clear all, retry, disclosure), game statuses, counts in chips and every data series are chrome.

**The Outcome Pair Rule.** Hit green and miss wine mean a real result against a real line. A miss always carries its hatch; a start with no line is slate; a missing value is outlined or labeled, never 0.

**The Purple Is Ground Rule.** Purple is surface and light, never body text on black. Lilac is the one readable purple, for initials and the live status.

**The Edge Pair Rule.** A hitter-against-pitch comparison is shaded violet for the pitcher's edge and chrome for the hitter's edge, never green and red, because neither side is "good". The shade is relative to MLB hitters on the same pitch, cells under the sample floor are never shaded, and the number is always printed.

## Typography

**Display Font:** Barlow Condensed (with Arial Narrow)
**Body Font:** Inter (with system-ui, Segoe UI)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, Cascadia Mono)

**Character:** Broadcast-graphics capitals for who and what, a neutral UI sans for everything you operate, and a mono that marks a number as measured. Scale carries the hierarchy: one very large figure per view, then names, then the reading face.

### Hierarchy
- **Name hero** (800, 56 to 156px fitted to the space, 0.8): the surname on Player Detail, the loudest word in the product.
- **Line hero** (800, 124px, 0.78, gold): the prop line on the ticket. **Result hero** (800, 118px): the sample hit rate, green when good and soft red when bad, with the W–L record at 60px beside it.
- **Page title** (800, 76px Home / 60px Board, 0.8, capitals): the slate name and "Pitcher props". 46px and 44px on phones.
- **Chapter title** (800, 46px, capitals): report chapters on Player Detail.
- **Slate figures** (800): Home's start time at 42px with AM/PM at 16px; teams at 34px; Board game bands at 32px; the Board line at 30px; pitcher names at 25px in capitals.
- **Finding** (500, 22px, 1.25, max 74ch): the one computed sentence under each chapter title; its numbers stay in the same face so it reads as one line.
- **Caption** (700, 14px, 0.06 to 0.12em tracking, capitals): chapter kickers, sample labels, result captions, game status, and the O/U side letters. Short labels only, never sentences.
- **Body** (Inter 400, 15px, 1.5, max 62ch) and **Label** (Inter 500 to 600, 12 to 13px, sentence case): UI copy, metadata, column headers, legends.
- **Odds** (Plex Mono 600, 20px on the Board, 26px on the ticket, 14px on Home) and **Data** (Plex Mono 400 to 600, 12 to 14px, tabular): prices, counts, axis values, stat tables.

Nothing load-bearing is set below 12px. Inter and Plex Mono use the fixed rem ramp (12, 13, 14, 15, 17, 20, 24, 30, 40, 52); Barlow figures take the literal sizes above.

### Named Rules
**The One Big Figure Rule.** Each view has one oversized figure that answers its question: the start time on Home, the line on the Board, the line and then the hit rate on Player Detail. Everything else steps down.

**The Measured Number Rule.** Plex Mono is for prices and measured stats. Headline figures (line, hit rate, record, clock, strip counts) are Barlow; clock times in running text use Inter tabular figures.

## Layout

A persistent shell: a 236px sidebar beside the workspace (page padding clamp(16px, 3vw, 40px) at the sides, max width 1480px). From 768 to 1279px the sidebar folds to a 68px icon rail. Under 768px the sidebar leaves for a 56px top bar and a fixed three-tab bottom bar (Home, Props, Matchups; 64px plus safe area). The current tab carries a straight 3px gold bar at its top edge.

Spacing runs on a 4px base (4, 8, 12, 16, 20, 24, 32, 40, 48). Big vertical rhythm is set per surface: 112px between report chapters, 56px between Home days, 34px above a Board game band.

### Breakpoints
- **1360px:** Player Detail's quick-read rail sits beside the report only at 1360 and up; below, one column.
- **1280px:** full sidebar at 1280 and up. From 768 to 1279 the rail sidebar, and the Board's two-line tablet filter bar.
- **1180px:** the Board drops its separate Prop column (the prop already names each row).
- **1024px:** Home's time column narrows to 92px and line lists stack; Player Detail's portrait and name share a row with the ticket below; Lineup Matchups' matrix becomes one hitter at a time below 1024.
- **900px:** Board rows recompose into a grid (prop and line, both prices, then the strip); the column header hides.
- **768px:** phone shell, the Board's filters move into a bottom sheet, Home games stack.
- **560px and 400px:** compact Board rows; tighter Player Detail price rows.

### Named Rules
**The Recompose, Don't Drop Rule.** A phone gets the same research. Narrow layouts reorder and regrid; they never hide a number the decision needs.

**The Open Composition Rule.** Home, the Board and Player Detail do not put content in panels. A section is a hard rule with its chrome tab, a title and its content on the page. Boxes exist only for things you operate (inputs, segments, price cells) and for layers that float.

## Elevation & Depth

Depth is tonal and flat. Surfaces step from Stage through Recess, Night and Control ink and are separated by chrome hairlines. The ticket is the one raised object in the product: purple gradient, violet edge, a brighter top edge. Real shadows exist only for layers that float: popovers, the account menu and the portrait cutout.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 18px 48px rgba(4, 1, 10, 0.6)`): popovers and menus.
- **Cutout** (`filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.45))`): the athlete cutout over his action photo.
- **Scrim** (`rgba(5, 2, 10, 0.64)`): behind the phone filter sheet.

### Named Rules
**The Hairline Rule.** Separation is a chrome hairline or a tonal step, never a shadow. A shadow means "this floats".

**The Opaque Sticky Rule.** Every sticky layer (filter bar, column header, pitcher strip, phone bars) is fully opaque, so rows scrolling under it never show through. The Board table uses separate borders for the same reason.

## Shapes

Near-square is the house shape: data marks, controls, price cells, tokens, tags and the ticket are 2px. Floating layers (popovers, the account menu) round at 10px, and the phone filter sheet rounds its top corners at 14px. Circles are for headshots, the switch knob, badges, the live-status dot and dot marks.

The Strike is one canonical angle, 22 degrees, from the PWR bolt.
- **Portrait cut:** Player Detail's portrait field and cutout are clipped on the Strike, with a 2px gold hairline laid on the cut.
- **"You are here" blades** (skewX(-22deg), vertical only): the sidebar's active item, the report index's current entry, the selected side on the ticket, and the gold blade on the Home starter or Board row under the pointer or keyboard focus.
- Horizontal markers stay straight: segment and tab underlines, the prop chip underline, the tab bar indicator, the sample underline.

### Named Rules
**The Strike Rule.** 22 degrees on the portrait cut and on vertical "you are here" markers only. Never on cards, buttons, tables or horizontal edges.

**The Square Data Rule.** 2px for anything precise. Soft corners only on layers that float.

## Components

### Chapter opening (shared)
A full-width 1px Hairline Strong rule with a 56 by 5px chrome tab sitting on its left end (top -2px). It opens Player Detail chapters, Home days and Board game bands, so all three surfaces turn their pages the same way.

### Home: the slate
- **Header:** the slate name as the page title ("Tomorrow's slate"), the long date in 20px Barlow capitals, the gold primary "Open the board" beside a ghost "Lineup matchups". One line of real facts scoped to the slate on screen (games, lines for pitchers, books, odds freshness), separated by 14px hairline dividers that never open a wrapped line; then "Markets posted" with each market in Barlow capitals. No stat cards.
- **Games:** the lead day opens on the chapter rule with its schedule and lineup note; later days collapse to one summary line each (a details disclosure). Each game is a row: a 116px time column (clock at 42px, status beneath), then the matchup (teams at 34px, venue right), then both starters side by side over a hairline divider.
- **Starter:** 52px real headshot (initials when none), name at 25px, "TEAM starter", a green "OPP lineup posted" flag when MLB has posted it, then each posted market's main line: market abbreviation, the line at 25px Barlow, O and U prices in mono. "No props posted yet" when the books have nothing. The whole starter is one link; hover or focus lights a chrome wash and the gold Strike blade.
- **Game status:** Barlow 700 14px capitals. Final and pre-game are text-3 chrome. In progress is Lilac with a 7px dot that pulses gently. Delays, postponements and suspensions are full-strength chrome. Never gold or amber.

### Board: the market terminal
- **Filter bar (sticky, Stage, opaque):** search, prop chips, Both/Over/Under, Main lines, and "Games, teams, pitchers" (a popover with checklists). Active filters show as Control Ink tokens with a remove icon, then "Clear all" in chrome. Desktop: two lines. Tablet (768 to 1279): two deliberate lines, search and props first, the rest second, with the prop chips scrolling sideways behind an edge fade if they run out of room. Phone: search plus a Filters button; the full set opens as a bottom sheet with a "Show N lines" primary.
- **Prop chip:** hairline outline, text-2, mono count. Pressed: 8% chrome fill, chrome text, a 2px gold underline.
- **Key:** one line under the bar explains the strip: solid "Went over the line", hatched "Did not", outlined "No recorded value". The copy follows the selected side.
- **Column header (sticky, Night, opaque):** Pitcher and prop, Line, Over, Under, Last 10 starts. Sortable columns use aria-sort.
- **Grouping (time order):** a game band (chapter rule, teams at 32px, day and time, venue, line count), then each pitcher established once (48px headshot, name at 25px, "TEAM vs OPP"), then his prop rows indented 62px beneath without separators. Any other sort is a flat list that names the pitcher on every row.
- **Sticky pitcher strip:** in grouped mode, once a pitcher's header scrolls under the column header, a 46px strip (40px on phones) in Night takes its place: the game in 17px Barlow, a hairline, a 28px headshot, the name at 20px and the team. The next pitcher or game band pushes it up underneath the header. It never covers the filter bar or the column header, and it is hidden from assistive technology because the real header row is the accessible one.
- **Prop row:** market name (with an "Alt line" tag when not the main line), the line as a 30px Barlow figure, two price cells, the last-10 strip, and an expander. Each price cell is a link: side letter on phones, odds in 20px mono, the book in 12px text-3 underneath. The expander opens every book's price and the alternate lines beneath the row.

### Lineup Matchups: the matchup lab
- **Scoreboard strip:** a full-bleed Stage strip of games (time, teams in 24px Barlow, status or lineup state). The selected game is lit with a chrome wash and an inset 2px gold underline. Arrow keys move along it (radio group).
- **Versus band:** the game on the chapter rule with a starter switch (segmented, one side per starter, TBD disabled). Then the pitcher once (84px real headshot, name at 64px, hand and team, a 2026 line in mono, a link to his scouting report) against the opponent (abbreviation at 64px, full name, lineup state). "Batting order posted" is a green-outlined caption; "Lineup not posted" says the list is the nine hitters with the most PA, ranked by PA, not a batting order.
- **What he throws:** one usage band (width = share of pitches, pitch tones by usage rank) with his whiff rate hanging beneath each pitch as a stem on its own scale. Pitches under 3% are named in the key and left out of the matrix.
- **Lineup vs his mix:** computed findings (Barlow 500 21px) beside best and toughest hitter matchups by the weighted figure. Findings and rankings are skipped when the data can't support them.
- **Hitter by pitch (signature):** hitters down, his pitches across (most used first), one metric at a time (xBA, Whiff%, K%). Column heads carry a tone swatch, usage with a usage bar, and the MLB average for the metric. Cells print the value in 24px Barlow with the sample beneath, shaded by the Edge Pair Rule. A "vs his mix" column (xBA and K% only) weights each hitter's values by the share of the pitcher's PA that end on each pitch, with its coverage printed, and sorts. A pooled lineup row closes the table. Posted orders break after the 3rd and 6th hitters; ranked lists use outlined numerals. A row opens an inspector: the hitter against every pitch (PA, pitches, BA, xBA, Whiff%, K%, hard-hit), his season line, his last 60 days against the pitcher's hand, and his history against the pitcher, which leads with its PA so a short history never reads as a rate. The method sits under the matrix with the exact formula in a disclosure.
- **Under 1024:** each hitter is a row with his weighted figure and best and toughest pitch, then a chip per pitch (same shading), and expands to the same inspector. Nothing needs sideways scrolling except the inspector's per-pitch table.

### Player Detail: the lab and the report
- **Portrait:** the athlete's real MLB cutout standing in front of his own action photo, which is rendered grayscale at 56% in luminosity blend on a plum field, graded from the upper left down to Stage. Both are clipped on the Strike with the gold hairline on the cut. With no cutout on file the headshot fills the frame; with no photo at all, initials. Never a stand-in athlete or a generic image.
- **Identity:** first name in 34px text-2, surname as the name hero tucked into the slant of the cut, the matchup at 26px Barlow, then hand, first pitch and park in Inter.
- **Ticket:** stat tabs (the selected one gets a gold underline and wash), the line as a 124px gold object with an "Alt" picker, and Over and Under as sportsbook price rows (side, odds, book, implied probability). The selected side carries a gold wash and the gold Strike blade.
- **Signal:** sample tabs (Season, L10, L25, H2H) with gold underlines; the result (hit rate, W–L record, a one-sentence verdict); the game-log chart with the selected window lit in violet and the gold bracket spanning it.
- **Report:** chapters open on the chapter rule with a numbered kicker (mono number), a 46px title and the finding. Each takes the shape of its question: the lineup as a batting order, the pitch matchup as a duel on one shared scale, the arsenal as one pitch system, same-handed starters as a dated ledger, the opponent profile as a plot with its two findings ringed, the season profile as a gradecard. On phones each chapter collapses to its title and finding and opens from its header.

### Charts and marks
- **Game-log chart and last-10 strip:** one bar or cell per start. Hit is solid green; miss is wine with a 135 degree hatch and an inset outline; a start with no posted line is slate; a start with no recorded value is an outlined empty cell on the strip or a labeled gap on the chart, and is left out of the count. The line is a 2px gold rule with a gold tag. Values sit above the bars in Barlow; axis dates are Plex Mono at 11 to 12px, a supporting label whose value also appears in the tooltip and the table view. The strip prints its count (6/10) in Barlow with the side word, and the chart has a legend and a table view.
- **Usage versus whiff:** usage is width, whiff is length, and the two never share a dimension. The arsenal is one continuous band where each pitch's slice width is its share of pitches, filled from the chrome-to-violet pitch tones by usage rank. Whiff rate hangs from each slice as a fixed-width stem whose length is the whiff rate, with its value printed. The pitch that misses the most bats gets a chrome cap and ring. The full table sits behind a disclosure. The pitch matchup puts his whiff rate beside the opponent's on one shared scale. Pitches never take outcome colors or gold.

### Buttons and controls
- **Primary:** gold fill, gold-ink text, Barlow 700 capitals, 40 to 46px tall, 2px. One per view.
- **Quiet:** transparent with a Hairline Strong border; hover turns the border and text gold. **Ghost:** text-2, hover fills Hover Ink. Utility actions such as Clear all are plain chrome text that underlines on hover.
- **Segmented control:** a Recess tray of 34px segments; the selected one fills Control Ink with a straight 2px gold underline.
- **Switch:** Control Ink track; on, it takes Gold Wash and a gold knob.
- **Search:** Recess fill, Hairline Strong border, leading icon, a "/" shortcut hint on desktop.
- **Badge:** a gold count of active filters on the button that holds them.

### Navigation
Sidebar items are 44px in Inter 15px text-2 with 22px icons and mono counts. The current page takes a 7% chrome wash, chrome text at 600 and the gold Strike blade on its left edge. Sports that are not live are shown disabled with "Soon". The phone uses the top bar and the three-tab bottom bar described in Layout.

### Motion
One curve, cubic-bezier(0.22, 1, 0.36, 1), at three speeds: 140ms for hover, press, color and blade changes; 220ms for sheets, scrims and chart labels; 420ms for the chart's sample window and bracket moving. The Board's rows rise 6px and fade in once on first load (260ms), dim briefly on refresh (180ms), and opened book rows drop 4px into place (180ms). Portrait images fade in as they load (400 to 600ms). Routes crossfade in 160ms with native view transitions. The live status dot pulses on a 1.8s cycle. The sticky pitcher strip follows the scroll with no animation of its own. There are no scroll-triggered reveals, parallax or looping decoration. Under prefers-reduced-motion every animation and transition collapses to an instant change.

### Accessibility
- Contrast: chrome text 16.3, 9.1 and 6.6 to 1; gold 8.5 to 1; hit and neg text 8.6 and 7.4 to 1.
- Focus: a 2px gold outline offset 2px on every interactive element, and a skip link. Sticky layers never hide the focused element: the page's scroll padding includes the filter bar, the column header and the pitcher strip.
- Targets: every segment, chip, token, button and switch is 44px under a coarse pointer. Board rows on phones keep 44px prop links and expanders and 58px price cells.
- Outcomes and states are never color alone: misses are hatched, strips print their count, prices read as sentences to screen readers ("Over 7.5 at +102, best of 2 books at FanDuel"), and game status is a word.
- The Board is a real table with a caption, scoped headers and aria-sort. Loading cells are aria-busy, and the line count is a polite live region. Up and down arrows move between rows. The phone filter sheet is a modal dialog that closes on Escape.
- Missing data is stated, never invented: "No props posted yet", "No game log", "No recorded value", initials instead of a stand-in photo.

## Do's and Don'ts

### Do:
- **Do** open sections, days and games on the chapter rule (1px Hairline Strong plus the 56 by 5px chrome tab) instead of putting them in panels.
- **Do** give each view one oversized Barlow figure: the start time, the line, the hit rate.
- **Do** keep gold to the line, the selection, the primary action, the row you're on and focus.
- **Do** set prices and measured stats in Plex Mono with tabular figures, and names and headline figures in Barlow Condensed capitals.
- **Do** establish a pitcher once on the Board and keep him in view with the sticky pitcher strip.
- **Do** encode a miss with the wine hatch and outline, show no-line starts in slate, and show a missing value as an outlined cell or a labeled gap.
- **Do** give usage width and whiff length, never both on one axis.
- **Do** use real MLB headshots and team abbreviations on Home and the Board, and keep photography for Player Detail.
- **Do** keep every sticky layer opaque and every touch target at 44px.
- **Do** print the sample under every matchup value, and leave values under 20 PA (50 pitches for Whiff%) unshaded and out of every derived figure.
- **Do** weight only PA-based metrics (xBA, K%) by the pitcher's PA share; Whiff% is per swing and is never blended.

### Don't:
- **Don't** make utility actions (Clear all, retry, disclosure) or game statuses gold or amber.
- **Don't** add photography, team logos or atmosphere imagery to Home or the Board without a functional reason.
- **Don't** use hit green or miss wine for anything that is not a real outcome or a better/worse comparison.
- **Don't** apply the 22 degree Strike to cards, buttons, tables or horizontal edges.
- **Don't** add KPI tiles, stat cards or fake summary widgets; one line of real facts replaces them.
- **Don't** set purple as body text on the dark ground.
- **Don't** use shadows to separate things that do not float.
- **Don't** let a filter bar wrap into a third line; recompose it instead.
- **Don't** set load-bearing text below 12px.
- **Don't** present a ranked-by-PA list as a batting order, invent a projected lineup, or show batter handedness the data doesn't carry.
- **Don't** turn matchup data into a single unexplained score; any blended figure shows its metric, sample, coverage and formula.
