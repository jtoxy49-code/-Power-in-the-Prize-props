import { refreshOdds } from "./odds.js";
import { refreshStats } from "./stats.js";
import { refreshBarrelStats } from "./barrels.js";

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
      const data = await env.PROPS_DATA.get("stats:barrels_raw");
      return new Response(data || "No barrel data in KV yet — run /debug/refresh-barrels first.", {
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
      ctx.waitUntil(refreshStats(env));
      ctx.waitUntil(refreshBarrelStats(env));
    }
  },
};
