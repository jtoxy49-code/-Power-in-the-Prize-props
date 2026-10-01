// Thin client for the Worker's /api routes. Every route, parameter and
// response shape is unchanged from the original single-file app; this module
// only de-duplicates in-flight requests and keeps short-lived results so that
// moving between the board and a pitcher does not refetch the same payloads.

const cache = new Map(); // url -> { at, promise }
const TIMEOUT_MS = 45_000;

async function getJSON(url, { ttl = 60_000, fresh = false } = {}) {
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.promise;
  // A request never hangs a section: after TIMEOUT_MS it fails into that
  // section's error state with Retry. The Worker keeps going and caches its
  // result, so the retry is usually instant.
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  const promise = fetch(url, { credentials: "same-origin", signal: ctrl?.signal }).finally(() => clearTimeout(timer)).then(async (res) => {
    if (res.status === 401 || res.status === 403) {
      // Session expired (401) or Premium role gone (403): "/" serves the
      // Discord login or the Premium-required page.
      window.location.href = "/";
      throw new Error(res.status === 401 ? "Not authenticated" : "Premium required");
    }
    if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
    return res.json();
  });
  cache.set(url, { at: Date.now(), promise });
  promise.catch(() => cache.delete(url));
  return promise;
}

const q = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

export const api = {
  me: () => getJSON("/api/me", { ttl: 10 * 60_000 }),
  odds: (opts) => getJSON("/api/odds", { ttl: 60_000, ...opts }),
  pitcherIds: () => getJSON("/api/pitcher-ids", { ttl: 30 * 60_000 }),
  lineups: (date) => getJSON(`/api/lineups${date ? `?date=${date}` : ""}`, { ttl: 5 * 60_000 }),
  pitcher: (name) => getJSON(`/api/pitcher?${q({ name })}`, { ttl: 60_000 }),
  gamelog: (id) => getJSON(`/api/gamelog?${q({ id })}`, { ttl: 5 * 60_000 }),
  pitchMetrics: (id) => getJSON(`/api/pitch-metrics?${q({ id })}`, { ttl: 10 * 60_000 }),
  pitcherSplits: (id, stand) => getJSON(`/api/pitcher-splits?${q({ id, stand })}`, { ttl: 30 * 60_000 }),
  pitcherHand: (id) => getJSON(`/api/pitcher-hand?${q({ id })}`, { ttl: 24 * 60 * 60_000 }),
  teamBatters: (team) => getJSON(`/api/team-batters?${q({ team })}`, { ttl: 5 * 60_000 }),
  teamSplits: (team, { hand, pitcherId } = {}) =>
    getJSON(`/api/team-splits?${q({ team, hand, pitcherId })}`, { ttl: 30 * 60_000 }),
  teamPitchSplits: (team) => getJSON(`/api/team-pitch-splits?${q({ team })}`, { ttl: 5 * 60_000 }),
  batterPitchTypes: (ids) => getJSON(`/api/batter-pitch-types?${q({ ids: ids.join(",") })}`, { ttl: 5 * 60_000 }),
  batterVsPitcher: (batterId, pitcherId) =>
    getJSON(`/api/batter-vs-pitcher?${q({ batterId, pitcherId })}`, { ttl: 30 * 60_000 }),
  sameHanded: (team, hand) => getJSON(`/api/same-handed?${q({ team, hand })}`, { ttl: 10 * 60_000 }),
  weather: (team, gameTime) => getJSON(`/api/weather?${q({ team, game_time: gameTime })}`, { ttl: 30 * 60_000 }),
  parkFactors: (team) => getJSON(`/api/park-factors?${q({ team })}`, { ttl: 60 * 60_000 }),
};
