// NFL SNAPSHOT: every request reads one build, whole.
//
// KV has no multi-key transaction, and each key reaches each edge location on
// its own schedule. So the builder never overwrites a serving key. It writes a
// build under keys of its own,
//
//   nfl:build:{build_id}:slate:current, nfl:build:{build_id}:team:BAL, ...
//
// which no reader has been told about yet, and then moves ONE key, nfl:current,
// that names the build to read and the one before it. A request reads that
// pointer once and takes every payload from the build it names.
//
// What that does and does not give:
//   - A response is never assembled from two builds. An edge that still has the
//     older pointer serves the older build, complete.
//   - If a key of the named build cannot be read (a write that never landed, an
//     edge that has the pointer before a payload), the WHOLE request is answered
//     again from the previous build. If that one is unreadable too, the request
//     fails with 503. It is never answered in part.
//   - It is not a transaction across requests. For about a minute after a
//     publish, two requests can be answered from different builds. Each response
//     names its build (build_id in the body, x-nfl-build in the headers).
//
// The keys written before this scheme (nfl:slate:current and so on, with no
// build in the name) are read only while no pointer exists.

export const POINTER_KEY = "nfl:current";
export const BUILD_PREFIX = "nfl:build:";

/** "nfl:slate:current" in build B is stored at "nfl:build:B:slate:current". */
export const buildKey = (buildId, key) => `${BUILD_PREFIX}${buildId}:${key.slice(4)}`;

class MissingKey extends Error {}
export class SnapshotUnavailable extends Error {
  constructor() { super("the current NFL build and the one before it are both unreadable"); }
}

function reader(env, build) {
  if (!build) return { build_id: null, get: (key) => env.PROPS_DATA.get(key, "json") };
  const names = new Set(build.names);
  return {
    build_id: build.build_id,
    async get(key) {
      if (!names.has(key.slice(4))) return null; // this build never had that key
      const value = await env.PROPS_DATA.get(buildKey(build.build_id, key), "json");
      if (value == null) throw new MissingKey(key);
      return value;
    },
  };
}

/**
 * Runs fn against one build. fn receives { build_id, get(key) } where key is
 * the payload's plain name ("nfl:slate:current"). fn may run twice (once per
 * build tried), so it must only read.
 */
export async function withSnapshot(env, fn) {
  const pointer = await env.PROPS_DATA.get(POINTER_KEY, "json");
  if (!pointer?.current) return fn(reader(env, null));
  for (const build of [pointer.current, pointer.previous]) {
    if (!build) continue;
    try { return await fn(reader(env, build)); } catch (err) { if (!(err instanceof MissingKey)) throw err; }
  }
  throw new SnapshotUnavailable();
}
