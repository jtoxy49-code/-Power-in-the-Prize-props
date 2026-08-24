export default {
  async fetch(request, env, ctx) {
    // Serves everything in /public — index.html, and any future
    // pages/assets you add there. No routing logic needed yet.
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") {
      console.log("Odds refresh trigger fired");
      // odds fetch logic goes here (SharpAPI)
    } else {
      console.log("Stats refresh trigger fired");
      // stats fetch logic goes here (Baseball Savant / Statcast)
    }
  },
};
