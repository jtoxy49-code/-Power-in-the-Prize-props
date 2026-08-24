import { refreshOdds } from "./odds.js";

export default {
  async fetch(request, env, ctx) {
    // Serves everything in /public — index.html, and any future
    // pages/assets you add there.
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") {
      ctx.waitUntil(refreshOdds(env));
    } else {
      console.log("Stats refresh trigger fired");
      // stats fetch logic goes here (Baseball Savant / Statcast) — next up
    }
  },
};
