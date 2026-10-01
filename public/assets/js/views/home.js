// HOME: "what can I research right now?" Built only from real data: the odds
// feed, the pitcher-id map, and the next four days of MLB schedule/lineups.
import { loadSlate, groupRows, sideBest, abbr, marketLabel, marketRank, MARKET_SHORT, bookName, nameKey, isPregameStatus } from "../domain.js";
import { esc, time, relDay, ago, dateShort, line as fmtLine, odds as fmtOdds } from "../format.js";
import { avatar, pitcherHref, errorState } from "../ui.js";
import { icon } from "../icons.js";

export function render(root) {
  root.innerHTML = `<div class="page home" id="home">${skeleton()}</div>`;
  let alive = true;
  const load = async () => {
    try {
      const slate = await loadSlate();
      if (!alive) return;
      // Without the full MLB schedule the slate would be wrong, so say so and offer Retry.
      if (slate.scheduleFailed) throw new Error("schedule");
      paint(root.querySelector("#home"), slate);
    } catch (err) {
      if (!alive) return;
      root.querySelector("#home").innerHTML = errorState("Couldn't load today's slate.", "The odds or schedule request failed. Check your connection and try again.", "home-retry");
      root.querySelector("#home-retry")?.addEventListener("click", load);
    }
  };
  load();
  return () => { alive = false; };
}

function skeleton() {
  return `
    <div class="hm-head"><div class="hm-title"><span class="skeleton" style="display:block;width:340px;max-width:70vw;height:52px"></span>
    <span class="skeleton" style="display:block;width:220px;height:18px;margin-top:12px"></span></div></div>
    <div class="hm-slate" aria-busy="true">${Array.from({ length: 3 }, () => '<div class="hm-sk"><span class="skeleton"></span><span class="skeleton"></span></div>').join("")}</div>`;
}

function paint(el, slate) {
  const rows = groupRows(slate.props, slate.schedule);

  // Attach props to scheduled games (same teams, start within 12 hours).
  const days = slate.lineupsByDate.map((d) => ({
    ...d,
    games: d.games.map((g) => ({ ...g, rows: rows.filter((r) => sameGame(r, g)) })),
  }));
  const withGames = days.filter((d) => d.games.length);
  const lead = withGames[0];
  const todayHasGames = days[0].games.length > 0;
  const when = lead ? relDay(lead.games[0].game_time) : "";

  // The header speaks for the slate it names: lines, books and markets on the
  // lead day's games only, never the whole feed.
  const leadRows = lead ? lead.games.flatMap((g) => g.rows) : [];
  const leadProps = lead ? slate.props.filter((p) => lead.games.some((g) => sameGame({ home_team: p.home_team, away_team: p.away_team, game_time: p.event_start_time }, g))) : [];
  const books = [...new Set(leadProps.flatMap((p) => p.books.map((b) => b.sportsbook)))];
  const markets = [...new Set(leadProps.map((p) => p.market_type))].sort((a, b) => marketRank(a) - marketRank(b));
  const pitchersWithProps = new Set(leadRows.map((r) => r.player));

  const headline = lead ? `${when === "Today" ? "Today's" : when === "Tomorrow" ? "Tomorrow's" : dateShort(lead.date)} slate` : "No games on the schedule";
  // One line of real context: what is scheduled, what is priced, how fresh.
  const facts = lead ? [
    `${lead.games.length} ${lead.games.length === 1 ? "game" : "games"}${todayHasGames ? "" : " (none today)"}`,
    leadRows.length ? `${leadRows.length} ${leadRows.length === 1 ? "line" : "lines"} for ${pitchersWithProps.size} ${pitchersWithProps.size === 1 ? "pitcher" : "pitchers"}` : "No props posted yet",
    !leadRows.length && rows.length ? `${rows.length} ${rows.length === 1 ? "line" : "lines"} on the board for other games` : null,
    books.length ? books.map((b) => bookName(b)).join(" and ") : null,
    slate.updatedAt ? `odds updated ${ago(slate.updatedAt)}` : null,
  ].filter(Boolean) : [];

  el.innerHTML = `
    <header class="hm-head">
      <div class="hm-title">
        <h1 class="hm-h">${esc(headline)}</h1>
        ${lead ? `<p class="hm-date">${esc(longDate(lead.date))}</p>` : ""}
      </div>
      <div class="hm-actions">
        <a class="btn btn-primary hm-cta" href="/?view=board" data-link>${icon("rows")}Open the board</a>
        <a class="btn btn-ghost" href="/?view=matchups" data-link>Lineup matchups</a>
      </div>
      ${lead ? `<ul class="hm-facts" aria-label="Slate status">${facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : `<p class="lede">There are no MLB games in the next four days.</p>`}
      ${lead && markets.length ? `<p class="hm-markets"><span>Markets posted</span>${markets.map((m) => `<b>${esc(marketLabel(m))}</b>`).join("")}</p>` : ""}
    </header>
    <div class="hm-slate">
      ${withGames.length ? withGames.map((d, i) => dayBlock(d, slate, i === 0)).join("") : `<div class="state"><strong>Nothing scheduled.</strong><span>The next four days have no MLB games.</span></div>`}
    </div>`;
}

const marketOrder = marketRank;

function sameGame(row, g) {
  if (row.home_team !== g.home_team || row.away_team !== g.away_team) return false;
  if (!row.game_time || !g.game_time) return true;
  return Math.abs(new Date(row.game_time) - new Date(g.game_time)) < 12 * 3600_000;
}

function longDate(ymd) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${ymd}T12:00:00`));
}

function lineupSummary(day) {
  if (!day) return "No games scheduled";
  const total = day.games.length * 2;
  const posted = day.games.reduce((n, g) => n + (g.away_lineup_confirmed ? 1 : 0) + (g.home_lineup_confirmed ? 1 : 0), 0);
  return posted ? `${posted} of ${total} lineups posted` : "No lineups posted yet";
}

function dayBlock(day, slate, open) {
  const rel = relDay(day.games[0].game_time);
  const label = rel;
  const sub = rel.includes(",") ? "" : dateShort(day.date);
  // Unique starters: MLB probables plus pitchers only a sportsbook has posted so far.
  const starters = day.games.reduce((n, g) => {
    const names = new Set([g.away_probable_pitcher, g.home_probable_pitcher].filter(Boolean).map(nameKey));
    g.rows.forEach((r) => { if (r.team) names.add(nameKey(r.player)); });
    return n + Math.min(2, names.size);
  }, 0);
  const meta = `${day.games.length} ${day.games.length === 1 ? "game" : "games"}, ${starters} of ${day.games.length * 2} starters named. ${lineupSummary(day)}. Lineups post 1 to 2 hours before first pitch.`;
  const list = `<ol class="hm-games" role="list">${day.games.map((g) => gameRow(g, slate)).join("")}</ol>`;
  const head = `<span class="hm-day-l">${esc(label)}</span>${sub ? `<span class="hm-day-d">${esc(sub)}</span>` : ""}`;
  // Only the next slate is open; later days stay one line until asked for.
  return open
    ? `<section class="hm-day hm-lead" aria-labelledby="hm-lead-h"><h2 class="sr-only" id="hm-lead-h">${esc(label)}${sub ? `, ${esc(sub)}` : ""}</h2><p class="hm-day-meta hm-lead-meta">${esc(meta)}</p>${list}</section>`
    : `<details class="hm-day hm-later"><summary class="hm-day-h">${icon("caret-right")}${head}<span class="hm-day-meta">${esc(meta)}</span></summary>${list}</details>`;
}

function gameRow(g, slate) {
  const sides = ["away", "home"].map((side) => {
    const team = g[`${side}_team`];
    const opp = side === "away" ? g.home_team : g.away_team;
    const probable = g[`${side}_probable_pitcher`];
    // A sportsbook may post a starter MLB still lists as TBD. Home shows each
    // market's main line only; alternates live on the board.
    const allForSide = g.rows.filter((r) => r.team === team);
    const byMarket = new Map();
    allForSide.filter((r) => r.main).forEach((r) => { if (!byMarket.has(r.market)) byMarket.set(r.market, r); });
    const rowsForSide = [...byMarket.values()].sort((a, b) => marketOrder(a.market) - marketOrder(b.market));
    const name = probable || allForSide[0]?.player || null;
    const confirmed = g[`${side}_lineup_confirmed`];
    return { side, team, opp, name, probable: !!probable, rows: rowsForSide, confirmed };
  });
  const [t, ampm] = splitClock(time(g.game_time));
  const live = g.status && g.status !== "Scheduled";
  return `
    <li class="hm-game">
      <div class="hm-when">
        <span class="hm-clock"><b>${esc(t)}</b>${ampm ? `<i>${esc(ampm)}</i>` : ""}</span>
        ${live ? `<span class="game-status ${statusKind(g.status)}">${esc(g.status)}</span>` : ""}
      </div>
      <div class="hm-match">
        <div class="hm-teams">
          <span class="hm-t">${esc(abbr(g.away_team))}</span><span class="hm-at">@</span><span class="hm-t">${esc(abbr(g.home_team))}</span>
          ${g.venue ? `<span class="hm-venue">${esc(g.venue)}</span>` : ""}
        </div>
        <div class="hm-sides">${sides.map((s) => sideRow(s, g, slate)).join("")}</div>
      </div>
    </li>`;
}

// MLB's detailed game state, sorted into the three treatments Home draws.
function statusKind(s) {
  if (/progress|warmup|challenge|review/i.test(s)) return "gs-live";
  if (/delay|postpon|suspend|cancel/i.test(s)) return "gs-alert";
  return "";
}

function splitClock(t) {
  const m = String(t).match(/^(.*?)\s*([AP]M)$/);
  return m ? [m[1], m[2]] : [t, ""];
}

function sideRow(s, g, slate) {
  const matchup = `${g.away_team} @ ${g.home_team}`;
  const id = s.name ? slate.ids[s.name] : null;
  const main = s.rows.find((r) => r.main) || s.rows[0];
  const href = s.name
    ? pitcherHref({
        name: s.name, market: main?.market, line: main?.line, selection: main ? "Over" : null,
        opponent: s.opp, home_team: g.home_team, game_time: g.game_time, matchup, team: s.team,
      })
    : null;
  const who = s.name
    ? `${avatar(s.name, id, 52, "hm-face")}<span class="hm-sp-t"><span class="hm-sp-name">${esc(s.name)}</span><span class="hm-sp-meta">${esc(abbr(s.team))} starter${s.probable ? "" : ` <span class="tbd-tag" title="A sportsbook has posted props for this pitcher; MLB has not announced him as the probable starter yet.">Not yet confirmed by MLB</span>`}${s.confirmed ? `<span class="lineup-flag on">${icon("check")}${esc(abbr(s.opp))} lineup posted</span>` : ""}</span></span>`
    : `<span class="face face-tbd hm-face" style="--size:52px" aria-hidden="true"><span class="face-init">?</span></span><span class="hm-sp-t"><span class="hm-sp-name faint">Starter TBD</span><span class="hm-sp-meta">${esc(abbr(s.team))}</span></span>`;
  const props = s.rows.length
    ? `<ul class="hm-lines" aria-label="Main lines posted">${s.rows.map((r) => {
        const o = sideBest(r.over), u = sideBest(r.under);
        return `<li class="hm-line"><span class="hm-mk">${esc(MARKET_SHORT[r.market] || marketLabel(r.market))}</span><b class="hm-ln">${esc(fmtLine(r.line))}</b><span class="hm-px"><i>O</i><span class="num">${o ? fmtOdds(o.odds) : "-"}</span></span><span class="hm-px"><i>U</i><span class="num">${u ? fmtOdds(u.odds) : "-"}</span></span></li>`;
      }).join("")}</ul>`
    : `<p class="hm-none">${!s.name ? "" : isPregameStatus(g.status) ? "No props posted yet" : "Lines closed at first pitch"}</p>`;
  const inner = `<span class="hm-who">${who}</span>${props}`;
  return href
    ? `<a class="hm-sp" href="${esc(href)}" data-link aria-label="Research ${esc(s.name)}, ${esc(s.team)} against the ${esc(s.opp)}">${inner}<span class="go">${icon("caret-right")}</span></a>`
    : `<div class="hm-sp hm-sp-off">${inner}<span class="go"></span></div>`;
}
