---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

Scope: PWR Props workstation (Home, Today's board, Pitcher detail). Mode: Operate. Audience: PWR Premium bettors researching MLB pitcher props on phone and desktop equally. Task: board to one informed yes/no on a prop without losing place. Constraints: static ES modules, real data only, Worker/API/KV untouched.

## Direction contract
THESIS: The pitcher page reads like a scouting report: a market ticket (who, prop, line, price, hit rate across four samples, game log), then sections each opened by one fact computed from data. Refuses the equal-weight card grid and the tabbed-away research page.
OWN-WORLD: Near-black purple ground from the logo, a purple-deep sidebar layer, chrome text, gold rationed to the line, the active state and the primary action. Barlow Condensed for names and figures, Inter for UI, Plex Mono for measured numbers. Near-square controls, 10px panels, hairlines, one 22 degree cut on the headshot and nav marker.
STORY: The member sees the prop and how it has hit before anything else, then reads lineup, pitch matchup, arsenal, same-handed starters, team splits and season in that order, and returns to the board exactly where they left it.
FIRST VIEWPORT: Ticket left (face, name, K/H/ER/BB/Outs tabs with lines, Over/Under and line picker, best price, hero hit rate with Season/L10/L25/H2H, game-log chart); rail right with a quick-read index plus game, weather and park.
FORM: Scouting report, position 3 on the ordered list, seed key 2a15db66.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
