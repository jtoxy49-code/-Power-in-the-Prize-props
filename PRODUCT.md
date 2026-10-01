# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS ES modules in `/public`, served as Cloudflare Worker assets
(`run_worker_first = true`, so every asset sits behind the Discord session
gate). No build step. Confirmed by the user 2026-09-28: keep this stack;
split the old single-file frontend into real modules rather than migrate to
React/Next. The Worker (`src/`), KV layout, cron refreshes and every `/api/*`
contract are out of scope for frontend work.

## Users

Power in the Prize (PWR) Premium members, authenticated through Discord
(premium role check). They are bettors researching MLB pitcher props for
today's and the next few days' slates, either before placing a bet or to
check a pick PWR has posted. They use a phone and a desktop in roughly equal
measure (confirmed 2026-09-28: design both as first-class).

## Product Purpose

Get a member from "what pitcher props are posted" to an informed yes/no on a
single prop quickly. That means scanning the board, opening a pitcher, and
reading recent results against the posted line, the opposing lineup, the
arsenal and the environment, without leaving the product or losing their place.

## Positioning

PWR Props is PWR's own research workstation, included with Premium and
behind the picks, not a standalone SaaS. What sets it apart from generic prop
tools is the pitcher-vs-lineup depth: confirmed opposing lineups with per-batter
BvP broken down by pitch type, team plate discipline and batted ball against
this pitcher's arsenal, same-handed starters against the opponent, and
handedness splits. The product identity is PWR's multi-sport player-prop
research platform. Only MLB pitcher props are live; NFL/NBA are "soon" and must
never be presented as live.

## Operating Context

- Entry: Discord OAuth → premium role check → signed session cookie.
- Odds: SharpAPI via a 10-minute cron into KV `odds:latest`. Pitcher markets
  only (K, hits allowed, walks, ER, outs). Books seen: DraftKings, FanDuel
  (BetMGM and Caesars labels exist in the code).
- Stats: Baseball Savant / MLB Stats API, refreshed twice daily into KV and
  fetched on demand per pitcher (game log, pitch metrics, splits, BvP, same-handed).
- Shareable detail links (`?pitcher=…&line=…`) are posted in Discord.

## Capabilities and Constraints

- Real data only. Where a source lacks something (for example FIP, wRC+,
  or batter BB% for some splits), the UI shows N/A or a dash and never a
  plausible-looking number.
- Park factors are historical approximations and must stay labeled that way.
  The weather HR impact is an estimate and must stay labeled "est."
- Hit rate is computed client-side from the MLB game log against the selected
  line (strict over/under; pushes are impossible on half-lines). This logic is
  product truth and must not change.
- Every API route, KV key and calculation is fixed. Frontend work consumes it.

## Brand Commitments

The PWR Hub (`../PWR/pwr-hub`) is the brand source of truth. That means
Barlow Condensed for display, Inter for UI, IBM Plex Mono reserved for real
measured numbers, gold as the single accent, logo-sampled purples
(#16032b, #280a46, #43186a, #440b98) as ground and depth, cool chrome white
for voice, and the 22° Strike angle, used sparingly. The Hub's marketing
treatments (campaign-scale type, photography, redaction, cinematic motion)
do not transfer into the product.

## Evidence on Hand

- Live production data (read-only) in KV. As of 2026-09-28 the live board is
  6 props, 3 Wild Card games, strikeouts only, DK + FD. This is the
  postseason, not a regular-season-density day.
- Complete season stats, arsenal, batter merged and pitch-type data in KV.
- No historical odds exist anywhere, so no line history, no line movement and
  no closing-line data. Nothing may imply otherwise.

## Product Principles

1. Research speed over decoration. Every element earns its place by shortening
   the path from board to decision.
2. The prop drives the page. The selected market and line anchor every number
   shown below them.
3. Honest data. Label approximations, never fill gaps, and never present a
   recommendation the data does not make.
4. Depth on demand. Keep the full research depth, but disclose it in the order
   a bettor actually reads it.
5. Two first-class devices. A phone gets the same research, recomposed.

## Accessibility & Inclusion

WCAG 2.2 AA contrast. Over/under outcomes are never encoded by color alone.
Full keyboard operation with visible focus. Reduced motion is respected.
Tap targets are at least 44px on touch.
