import { refreshOdds } from "./odds.js";
import { refreshStats } from "./stats.js";
import { refreshBarrelStats } from "./barrels.js";
import { refreshSeasonStats } from "./season-stats.js";
import { buildMergedStats, normalizeName } from "./merge.js";
import { fetchGameLog } from "./gamelog.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
    // --- END DEBUG ROUTES ---

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(refreshOdds(env));
    } else {
      ctx.waitUntil(
        (async () => {
          await Promise.all([refreshStats(env), refreshBarrelStats(env), refreshSeasonStats(env)]);
          await buildMergedStats(env);
        })()
      );
    }
  },
};
