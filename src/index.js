export default {
  async fetch(request, env, ctx) {
    return new Response("PWR Props — Worker is live.", {
      headers: { "content-type": "text/plain" },
    });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === "*/10 * * * *") {
      console.log("Odds refresh trigger fired");
      // odds fetch logic goes here
    } else {
      console.log("Stats refresh trigger fired");
      // stats fetch logic goes here
    }
  },
};
