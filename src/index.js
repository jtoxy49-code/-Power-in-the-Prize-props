import { refreshOdds } from "./odds.js";
import { refreshStats } from "./stats.js";
import { refreshBarrelStats } from "./barrels.js";
import { refreshSeasonStats } from "./season-stats.js";
import { buildMergedStats, normalizeName } from "./merge.js";
import { fetchGameLog, getCachedGameLog } from "./gamelog.js";
import { refreshArsenalStats } from "./pitch-arsenal.js";
import { fetchLineupsForDate, getLineupsForDate } from "./lineups.js";
import { refreshParkFactors } from "./park-factors.js";
import { getParkFactors } from "./park-factors-static.js";
import { getVenueCoords } from "./venue-coords.js";
import { fetchWeatherForGame } from "./weather.js";
import { classifyWindForPark } from "./park-orientation.js";
import { estimateWeatherHrImpact } from "./weather-hr-model.js";
import { refreshBatterExpectedStats } from "./batter-expected.js";
import { refreshBatterSeasonStats } from "./batter-season.js";
import { buildMergedBatterStats } from "./batter-merge.js";
import { refreshBatterPitchTypeStats, getTeamPitchTypeSplits } from "./batter-pitch-types.js";
import { getTeamId, getTeamAbbreviation } from "./team-ids.js";
import { getSameHandedStartersVsTeam, fetchPitchHand } from "./same-handed.js";
import { getCachedPitchMetrics } from "./pitch-metrics.js";
import { getCachedTeamSplits } from "./team-plate-discipline.js";
import { getCachedMatchup } from "./batter-vs-pitcher.js";
import { getCachedPitcherSplits } from "./pitcher-splits.js";
import { getDiscordAuthUrl, exchangeCodeForUser, hasPremiumRole, createSessionCookie, verifySessionCookie } from "./auth.js";

function getLoginPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PWR Props — Log In</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{
  background:#0A080F;
  color:#F4F1FA;
  font-family:'Inter',sans-serif;
  min-height:100vh;
  display:flex; align-items:center; justify-content:center;
  padding:20px;
}
.login-wrap{
  width:100%; max-width:420px;
  text-align:center;
}
.logo-badge{
  position:relative;
  width:190px; height:190px;
  margin:0 auto 18px;
  display:flex; align-items:center; justify-content:center;
}
.logo-badge::before{
  content:"";
  position:absolute; inset:0;
  border-radius:50%;
  background:radial-gradient(circle, rgba(124,58,237,0.45) 0%, rgba(124,58,237,0) 72%);
}
.logo-badge img{
  position:relative; z-index:2;
  width:100%; height:100%;
  object-fit:contain;
}
.tagline{
  font-family:'Barlow Condensed',sans-serif;
  font-weight:700; font-size:14px; letter-spacing:4px;
  color:#9C93B5; margin-bottom:26px;
  text-transform:uppercase;
}
.tagline span{ color:#F5B400; }
h1{
  font-family:'Barlow Condensed',sans-serif;
  font-size:30px; font-weight:800;
  margin-bottom:10px;
}
p{
  font-size:14px; color:#A79FC0; line-height:1.55;
  margin-bottom:30px;
}
.discord-btn{
  display:flex; align-items:center; justify-content:center; gap:10px;
  background:linear-gradient(90deg,#7C3AED,#A66CF5);
  color:#fff; text-decoration:none;
  font-family:'Inter',sans-serif; font-weight:700; font-size:15px;
  padding:16px; border-radius:12px;
  box-shadow:0 8px 24px rgba(124,58,237,0.35);
  transition:filter 0.15s;
}
.discord-btn:hover{ filter:brightness(1.08); }
.discord-btn svg{ width:20px; height:20px; }
.footnote{
  margin-top:24px; font-size:13px; color:#8B83A0;
}
.footnote a{
  color:#B98CFF; font-weight:600; text-decoration:none;
}
.footnote a:hover{ text-decoration:underline; }
</style>
</head>
<body>
  <div class="login-wrap">
    <div class="logo-badge">
      <img src="/pwr-logo.png" alt="PWR logo">
    </div>
    <div class="tagline">POWER <span>IN THE</span> PRIZE</div>
    <h1>Log in to PWR Props</h1>
    <p>Sign in with Discord to access pitcher prop research, matchup data, and splits.</p>
    <a class="discord-btn" href="/login">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.076.076 0 0 0-.04.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.211 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
      Log in with Discord
    </a>
    <div class="footnote">Not a member yet? <a href="https://discord.gg/YOUR_INVITE" target="_blank">Join the server</a> first, then log in.</div>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Debug route gate — every /debug/* route requires a secret
    // key, set via env.DEBUG_KEY. Returns a plain 404 (not 401/403)
    // for wrong/missing keys, so unauthorized visitors can't even
    // confirm these routes exist.
    if (url.pathname.startsWith("/debug/")) {
      if (!env.DEBUG_KEY || url.searchParams.get("key") !== env.DEBUG_KEY) {
        return new Response("Not Found", { status: 404 });
      }
    }

    // --- Discord OAuth login flow ---
    if (url.pathname === "/login") {
      const redirectUri = `${url.origin}/auth/callback`;
      const authUrl = getDiscordAuthUrl(env.DISCORD_CLIENT_ID, redirectUri);
      return Response.redirect(authUrl, 302);
    }

    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          // Overwrite the session cookie with an already-expired one,
          // which makes the browser delete it immediately.
          "Set-Cookie": "pwr_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      });
    }

    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing authorization code.", { status: 400 });
      }
      try {
        const redirectUri = `${url.origin}/auth/callback`;
        const discordUser = await exchangeCodeForUser(code, env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET, redirectUri);
        const isPremium = await hasPremiumRole(discordUser.id, env.DISCORD_GUILD_ID, env.DISCORD_PREMIUM_ROLE_ID, env.DISCORD_BOT_TOKEN);

        if (!isPremium) {
          return new Response(
            `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0A080F;color:#F4F1FA;font-family:'Inter',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.card{background:#131020;border:1px solid #2B2540;border-radius:16px;padding:40px 36px;max-width:400px;text-align:center;}
h1{font-family:'Barlow Condensed',sans-serif;font-size:24px;font-weight:800;margin-bottom:14px;}
p{font-size:13.5px;color:#A79FC0;line-height:1.55;margin-bottom:22px;}
a{color:#F5B400;font-weight:600;text-decoration:none;font-size:13.5px;}
a:hover{text-decoration:underline;}
</style></head>
<body>
  <div class="card">
    <h1>Premium access required</h1>
    <p>PWR Props is exclusive to Power in the Prize premium members. If you believe this is a mistake, double check your role in Discord and try logging in again.</p>
    <a href="/login">Try logging in again &rarr;</a>
  </div>
</body></html>`,
            { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }

        const cookie = await createSessionCookie(discordUser.id, env.SESSION_SECRET);
        return new Response(null, {
          status: 302,
          headers: { Location: "/", "Set-Cookie": cookie },
        });
      } catch (err) {
        return new Response(`Login failed: ${err.message}`, { status: 500 });
      }
    }

    // --- Premium-role session gate — everything below this point
    // requires a valid, signed session cookie proving Discord
    // premium-role membership. Debug routes (already key-gated above)
    // are exempt, as are /login, /auth/callback, and any static
    // assets the login page itself needs to render (e.g. the logo) —
    // without this, the logo's own <img> request would get caught
    // by the gate and served the login page's HTML instead of the
    // actual image.
    const LOGIN_PAGE_ASSETS = ["/pwr-logo.png"];
    const sessionDiscordId = await verifySessionCookie(request.headers.get("Cookie"), env.SESSION_SECRET);
    if (!sessionDiscordId && !url.pathname.startsWith("/debug/") && !LOGIN_PAGE_ASSETS.includes(url.pathname)) {
      if (url.pathname.startsWith("/api/")) {
        return new Response('{"error":"Not authenticated"}', {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(getLoginPageHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

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
        const wind = weather?.game_time
          ? classifyWindForPark(team, weather.game_time.wind_direction_deg, weather.game_time.wind_mph)
          : null;
        const hrImpact = weather?.game_time
          ? estimateWeatherHrImpact(weather.game_time.temperature_f, weather.game_time.wind_mph, wind?.label)
          : null;
        return new Response(
          JSON.stringify({ team, game_time: gameTime, weather, wind, hr_impact_estimate: hrImpact }),
          {
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "public, max-age=1800",
            },
          }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/team-batters") {
      const team = url.searchParams.get("team");
      if (!team) {
        return new Response('{"error":"missing team parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const data = await env.PROPS_DATA.get("stats:batters_merged", "json");
      const batters = data?.by_team?.[team] || [];
      return new Response(
        JSON.stringify({ team, batters, updated_at: data?.updated_at || null }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        }
      );
    }

    if (url.pathname === "/api/team-pitch-splits") {
      const team = url.searchParams.get("team");
      if (!team) {
        return new Response('{"error":"missing team parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const splits = await getTeamPitchTypeSplits(env, team);
        return new Response(JSON.stringify({ team, splits }), {
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

    if (url.pathname === "/api/same-handed") {
      const team = url.searchParams.get("team");
      const hand = url.searchParams.get("hand"); // "L" or "R"
      if (!team || !hand) {
        return new Response('{"error":"missing team or hand parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const teamId = getTeamId(team);
      if (!teamId) {
        return new Response(JSON.stringify({ error: `no team ID found for: ${team}` }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const forceRefresh = url.searchParams.has("bust");
        const starters = await getSameHandedStartersVsTeam(env, teamId, team, hand, forceRefresh);
        return new Response(JSON.stringify({ team, hand, starters }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=600",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/pitch-metrics") {
      const playerId = url.searchParams.get("id");
      if (!playerId) {
        return new Response('{"error":"missing id parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const data = await getCachedPitchMetrics(env, playerId);
        return new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=600",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/api/team-splits") {
      const team = url.searchParams.get("team");
      const hand = url.searchParams.get("hand"); // optional "L" or "R"
      const pitcherId = url.searchParams.get("pitcherId"); // optional — overrides hand if both given
      if (!team) {
        return new Response('{"error":"missing team parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const abbrev = getTeamAbbreviation(team);
      if (!abbrev) {
        return new Response(JSON.stringify({ error: `no abbreviation found for team: ${team}` }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const data = await getCachedTeamSplits(env, abbrev, hand, pitcherId);
        return new Response(JSON.stringify(data), {
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

    if (url.pathname === "/api/batter-vs-pitcher") {
      const batterId = url.searchParams.get("batterId");
      const pitcherId = url.searchParams.get("pitcherId");
      if (!batterId || !pitcherId) {
        return new Response('{"error":"missing batterId or pitcherId parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const data = await getCachedMatchup(env, batterId, pitcherId);
        return new Response(JSON.stringify(data), {
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

    if (url.pathname === "/api/pitcher-splits") {
      const id = url.searchParams.get("id");
      const stand = url.searchParams.get("stand"); // optional "L" or "R", omit for overall
      if (!id) {
        return new Response('{"error":"missing id parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const data = await getCachedPitcherSplits(env, id, stand);
        return new Response(JSON.stringify(data), {
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

    if (url.pathname === "/api/pitcher-hand") {
      const id = url.searchParams.get("id");
      if (!id) {
        return new Response('{"error":"missing id parameter"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const { hand } = await fetchPitchHand(env, id);
        return new Response(JSON.stringify({ id, hand }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=86400",
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
      const dateParam = url.searchParams.get("date"); // optional YYYY-MM-DD, defaults to today
      try {
        const data = await getLineupsForDate(env, dateParam);
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
    if (url.pathname === "/debug/batter-split") {
      const year = new Date().getUTCFullYear();
      const team = url.searchParams.get("team") || "WSH";
      const hand = url.searchParams.get("hand") || "L";
      const testUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${year}&position=&team=${team}&min=1&hand=${hand}&csv=true`;
      try {
        const res = await fetch(testUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
        });
        const text = await res.text();
        const looksLikeCSV = !text.trim().startsWith("<");
        return new Response(
          JSON.stringify(
            {
              test_url: testUrl,
              status: res.status,
              looks_like_csv: looksLikeCSV,
              first_500_chars: text.slice(0, 500),
            },
            null,
            2
          ),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Batter split test failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/savant-raw") {
      const target = url.searchParams.get("u");
      if (!target) {
        return new Response('{"error":"pass the target URL via ?u=<url-encoded Savant URL>"}', {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      try {
        const res = await fetch(target, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" },
        });
        const text = await res.text();
        const looksLikeCSV = !text.trim().startsWith("<");
        return new Response(
          JSON.stringify(
            {
              target,
              status: res.status,
              looks_like_csv: looksLikeCSV,
              first_line: looksLikeCSV ? text.split("\n")[0] : null,
              first_300_chars: text.slice(0, 300),
            },
            null,
            2
          ),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Savant raw test failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/refresh-batter-expected") {
      try {
        await refreshBatterExpectedStats(env);
        return new Response("Batter expected stats refresh ran successfully. Check /debug/batter-expected to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Batter expected stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/batter-expected") {
      const data = await env.PROPS_DATA.get("stats:batters_expected");
      return new Response(data || "No data yet — run /debug/refresh-batter-expected first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-batter-season") {
      try {
        await refreshBatterSeasonStats(env);
        return new Response("Batter season stats refresh ran successfully. Check /debug/batter-season to view it.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Batter season stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/batter-season") {
      const data = await env.PROPS_DATA.get("stats:batters_season");
      return new Response(data || "No data yet — run /debug/refresh-batter-season first.", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/debug/refresh-batter-merge") {
      try {
        const byTeam = await buildMergedBatterStats(env);
        return new Response(
          `Batter merge ran successfully: ${Object.keys(byTeam).length} teams. Check /debug/batter-merged?team=X to view one.`,
          { headers: { "content-type": "text/plain; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Batter merge failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    if (url.pathname === "/debug/batter-merged") {
      const team = url.searchParams.get("team") || "Washington Nationals";
      const data = await env.PROPS_DATA.get("stats:batters_merged", "json");
      const teamBatters = data?.by_team?.[team] || null;
      return new Response(
        JSON.stringify({ team, batters: teamBatters, updated_at: data?.updated_at || null }, null, 2),
        { headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }
    if (url.pathname === "/debug/refresh-batter-pitch-types") {
      try {
        await refreshBatterPitchTypeStats(env);
        return new Response("Batter pitch-type stats refresh ran successfully.", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Batter pitch-type stats refresh failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/team-schedule") {
      const teamId = url.searchParams.get("teamId") || "120"; // Washington Nationals
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const testUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R`;
      try {
        const res = await fetch(testUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" } });
        const raw = await res.json();
        const games = (raw?.dates || []).flatMap((d) => d.games);
        const completed = games.filter((g) => g.status?.abstractGameState === "Final");
        return new Response(
          JSON.stringify(
            {
              games_found: games.length,
              completed_games: completed.length,
              sample_game: completed[completed.length - 1] || games[0] || null,
            },
            null,
            2
          ),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Team schedule test failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/boxscore") {
      const gamePk = url.searchParams.get("gamePk") || "822688";
      const testUrl = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
      try {
        const res = await fetch(testUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" } });
        const raw = await res.json();
        const awayPitchers = raw?.liveData?.boxscore?.teams?.away?.pitchers || [];
        const players = raw?.liveData?.boxscore?.teams?.away?.players || {};
        const starterId = awayPitchers[0];
        const starterKey = `ID${starterId}`;
        return new Response(
          JSON.stringify(
            {
              away_pitchers_in_order: awayPitchers,
              starter_id: starterId,
              starter_full_record: players[starterKey] || null,
            },
            null,
            2
          ),
          { headers: { "content-type": "application/json; charset=utf-8" } }
        );
      } catch (err) {
        return new Response(`Boxscore test failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/pitch-hand") {
      const id = url.searchParams.get("id") || "676083"; // Janson Junk from the boxscore test
      const testUrl = `https://statsapi.mlb.com/api/v1/people/${id}`;
      try {
        const res = await fetch(testUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" } });
        const raw = await res.json();
        return new Response(JSON.stringify(raw?.people?.[0] || null, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Pitch-hand test failed:\n${err.message}`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }
    if (url.pathname === "/debug/past-probable-pitcher") {
      const teamId = url.searchParams.get("teamId") || "143"; // Phillies
      const endDate = new Date().toISOString().slice(0, 10);
      const startDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const testUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&gameType=R&hydrate=probablePitcher,team`;
      try {
        const res = await fetch(testUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; PWRPropsBot/1.0)" } });
        const raw = await res.json();
        const games = (raw?.dates || []).flatMap((d) => d.games).filter((g) => g.status?.abstractGameState === "Final");
        const sample = games.slice(-3).map((g) => ({
          date: g.officialDate,
          away_probable: g.teams?.away?.probablePitcher || null,
          home_probable: g.teams?.home?.probablePitcher || null,
        }));
        return new Response(JSON.stringify({ finished_games_found: games.length, sample }, null, 2), {
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      } catch (err) {
        return new Response(`Test failed:\n${err.message}`, {
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
          await Promise.all([
            refreshStats(env),
            refreshBarrelStats(env),
            refreshSeasonStats(env),
            refreshArsenalStats(env),
            refreshBatterExpectedStats(env),
            refreshBatterSeasonStats(env),
            refreshBatterPitchTypeStats(env),
          ]);
          await buildMergedStats(env);
          await buildMergedBatterStats(env);
        })()
      );
    }
  },
};
