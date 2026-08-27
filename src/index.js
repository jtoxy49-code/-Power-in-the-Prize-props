import { refreshOdds } from "./odds.js";
import { refreshStats } from "./stats.js";
import { refreshBarrelStats } from "./barrels.js";
import { refreshSeasonStats } from "./season-stats.js";
import { buildMergedStats, normalizeName } from "./merge.js";
import { fetchGameLog, getCachedGameLog } from "./gamelog.js";
import { refreshArsenalStats } from "./pitch-arsenal.js";
import { fetchLineupsForDate, getTodaysLineups } from "./lineups.js";
import { refreshParkFactors } from "./park-factors.js";
import { getParkFactors } from "./park-factors-static.js";
import { getVenueCoords } from "./venue-coords.js";
import { fetchWeatherForGame } from "./weather.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/park-factors") {
      const team = url.searchParams.get("team");
      if (!team) {
        return new Response('{"error":"missing team parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const factors = getParkFactors(team);
      return new Response(
        JSON.stringify({
          team,
          factors,
          data_type: "historical_approximate", // NOT live-computed like other sources
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    if (url.pathname === "/api/weather") {
      const team = url.searchParams.get("team");
      const gameTime = url.searchParams.get("game_time");
      if (!team || !gameTime) {
        return new Response('{"error":"missing team or game_time parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const coords = getVenueCoords(team);
      if (!coords) {
        return new Response(JSON.stringify({ error: `no coordinates found for team: ${team}` }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const weather = await fetchWeatherForGame(coords.lat, coords.lon, gameTime);
        return new Response(JSON.stringify({ team, game_time: gameTime, weather }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=1800",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    // --- Public API routes ---
    if (url.pathname === "/api/odds") {
      const data = await env.PROPS_DATA.get("odds:latest");
      return new Response(data || '{"props":[],"updated_at":null}', {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=60",
        },
      });
    }

    if (url.pathname === "/api/pitcher") {
      const nameParam = url.searchParams.get("name") || "";
      const target = normalizeName(nameParam);

      const [mergedData, oddsData] = await Promise.all([
        env.PROPS_DATA.get("stats:merged", "json"),
        env.PROPS_DATA.get("odds:latest", "json"),
      ]);

      const statMatch = (mergedData?.pitchers || []).find(
        (p) => p.normalized_name === target
      );
      const propMatches = (oddsData?.props || []).filter(
        (p) => normalizeName(p.player_name) === target
      );

      return new Response(
        JSON.stringify({
          query: nameParam,
          matched: !!statMatch,
          stats: statMatch || null,
          props: propMatches,
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        }
      );
    }

    if (url.pathname === "/api/gamelog") {
      const playerId = url.searchParams.get("id");
      if (!playerId) {
        return new Response('{"error":"missing id parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const year = url.searchParams.get("year") || new Date().getUTCFullYear();
      try {
        const data = await getCachedGameLog(env, playerId, year);
        return new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/lineups") {
      try {
        const data = await getTodaysLineups(env);
        return new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    // --- TEMPORARY DEBUG ROUTES — remove before going live ---
    if (url.pathname === "/debug/refresh-odds") {
      try {
        await refreshOdds(env);
        return new Response("Odds refresh ran successfully. Check /debug/odds to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Odds refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/odds") {
      const data = await env.PROPS_DATA.get("odds:latest");
      return new Response(data || "No odds data in KV yet — run /debug/refresh-odds first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-stats") {
      try {
        await refreshStats(env);
        return new Response("Stats refresh ran successfully. Check /debug/stats to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/stats") {
      const data = await env.PROPS_DATA.get("stats:expected");
      return new Response(data || "No stats data in KV yet — run /debug/refresh-stats first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-barrels") {
      try {
        await refreshBarrelStats(env);
        return new Response("Barrel stats refresh ran successfully. Check /debug/barrels to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Barrel stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/barrels") {
      const data = await env.PROPS_DATA.get("stats:barrels");
      return new Response(data || "No barrel data in KV yet — run /debug/refresh-barrels first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-season") {
      try {
        await refreshSeasonStats(env);
        return new Response("Season stats refresh ran successfully. Check /debug/season to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Season stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/season") {
      const data = await env.PROPS_DATA.get("stats:season");
      return new Response(data || "No season data in KV yet — run /debug/refresh-season first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-merge") {
      try {
        const merged = await buildMergedStats(env);
        return new Response(
          `Merge ran successfully: ${merged.length} pitchers joined. Check /debug/merged to view it.`,
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Merge failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/merged") {
      const data = await env.PROPS_DATA.get("stats:merged");
      return new Response(data || "No merged data yet — run /debug/refresh-merge first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === "/debug/gamelog") {
      const playerId = url.searchParams.get("id") || "645261"; // defaults to Sandy Alcantara
      const year = new Date().getUTCFullYear();
      try {
        const raw = await fetchGameLog(playerId, year);
        const splits = raw?.stats?.[0]?.splits || [];
        return new Response(
          JSON.stringify({
            top_level_keys: Object.keys(raw || {}),
            games_found: splits.length,
            sample_games: splits.slice(0, 3), // just a few, not the whole season
          }, null, 2),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Game log fetch failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/refresh-arsenal") {
      try {
        await refreshArsenalStats(env);
        return new Response("Arsenal stats refresh ran successfully. Check /debug/arsenal to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Arsenal stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/arsenal") {
      const data = await env.PROPS_DATA.get("stats:arsenal");
      return new Response(data || "No arsenal data in KV yet — run /debug/refresh-arsenal first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.pathname === "/debug/lineups") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      try {
        const raw = await fetchLineupsForDate(date);
        const games = raw?.dates?.[0]?.games || [];

        const gameSummaries = games.map((g) => ({
          matchup: `${g.teams?.away?.team?.name} @ ${g.teams?.home?.team?.name}`,
          status: g.status?.detailedState || null,
          has_lineups_key: !!g.lineups,
          home_lineup_count: g.lineups?.homePlayers?.length || 0,
          away_lineup_count: g.lineups?.awayPlayers?.length || 0,
          away_probable_pitcher: g.teams?.away?.probablePitcher?.fullName || null,
          home_probable_pitcher: g.teams?.home?.probablePitcher?.fullName || null,
        }));

        const gameWithLineup = games.find((g) => g.lineups?.homePlayers?.length > 0);

        return new Response(
          JSON.stringify(
            {
              date,
              games_found: games.length,
              game_summaries: gameSummaries,
              sample_lineup_player: gameWithLineup?.lineups?.homePlayers?.[0] || null,
            },
            null,
            2
          ),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Lineups fetch failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/refresh-parks") {
      try {
        await refreshParkFactors(env);
        return new Response("Park factors refresh ran successfully. Check /debug/parks to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Park factors refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/parks") {
      const data = await env.PROPS_DATA.get("stats:parks_raw");
      return new Response(data || "No park data in KV yet — run /debug/refresh-parks first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    // --- END DEBUG ROUTES ---

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(refreshOdds(env));
    } else {
      ctx.waitUntil(
        (async () => {
          await Promise.all([
            refreshStats(env),
            refreshBarrelStats(env),
            refreshSeasonStats(env),
            refreshArsenalStats(env),
          ]);
          await buildMergedStats(env);
        })()
      );
    }
  },
};
