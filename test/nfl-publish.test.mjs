// Publishing a build to KV: what readers observe while it is being written,
// when it fails part of the way, and while it is still spreading to the edge.
//
// The publisher (etl/nfl/publish.mjs) and the reader (src/nfl/api.js through
// src/nfl/snapshot.js) run here against one in-memory store. Failures are
// injected into the store's operations, and after each one the real API
// handler is asked for every builder-backed route. The rule under test:
// every response comes from one build, complete. Never part of one and part
// of another, and never a build that was not finished.
import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./fixtures/nfl/load.mjs";
import { deriveAll } from "../etl/nfl/build.mjs";
import { buildPayloads } from "../etl/nfl/payloads.mjs";
import { publishKv, KV_SETTLE_MS } from "../etl/nfl/publish.mjs";
import { handleNflApi } from "../src/nfl/api.js";
import { refreshNflOdds } from "../src/nfl/odds.js";
import { POINTER_KEY, BUILD_PREFIX, buildKey } from "../src/nfl/snapshot.js";

const { season, source } = loadSource();
const NOW = Date.parse("2026-10-02T09:00:00Z");
const LAMAR = "00-0034796";

// Three real builds from the 2026 fixture. They differ in content, not just in
// name: A is the state entering Week 3, B and C the state entering Week 4.
const make = (buildId, asOfWeek, builtAt) => {
  const payloads = buildPayloads(deriveAll({ season, source, asOfWeek, capturedDate: builtAt.slice(0, 10), buildId, builtAt }).derived);
  return { buildId, asOfWeek, payloads, entries: Object.entries(payloads).map(([key, value]) => ({ key, value: JSON.stringify(value) })) };
};
const A = make("build-A", 3, "2026-09-24T08:20:00.000Z");
const B = make("build-B", 4, "2026-10-01T08:20:00.000Z");
const C = make("build-C", 4, "2026-10-02T08:20:00.000Z");
const WEEK = { "build-A": 3, "build-B": 4, "build-C": 4, unversioned: 3 };

/** One KV namespace, seen by the publisher (client) and by a Worker at an edge (binding). */
function fakeKv() {
  const store = new Map();
  const calls = [], overwrites = [], fault = {};
  let afterWrite = null;
  const set = async (k, v) => { if (store.has(k)) overwrites.push(k); store.set(k, v); if (afterWrite) await afterWrite(k); };
  const client = {
    async list(prefix) { calls.push(`list ${prefix}`); if (fault.list?.(prefix)) throw new Error("injected: the list request failed"); return [...store.keys()].filter((k) => k.startsWith(prefix)); },
    async get(key) { calls.push(`get ${key}`); if (!store.has(key)) throw new Error("404 not found"); return fault.garbles?.(key) ? "<html>502 bad gateway</html>" : store.get(key); },
    async bulkPut(entries) {
      calls.push(`bulkPut ${entries.length}`);
      for (const [i, e] of entries.entries()) {
        if (fault.bulkPutDiesAt === i) throw new Error("injected: the connection dropped during the bulk write");
        if (fault.drops?.(e.key)) continue; // the request "succeeded"; this key never landed
        await set(e.key, e.value);
      }
    },
    async put(key, value) {
      calls.push(`put ${key}`);
      if (fault.put === "rejected") throw new Error("injected: the pointer write was rejected");
      await set(key, value);
      if (fault.put === "response_lost") throw new Error("injected: the pointer write landed but its response was lost");
    },
    async bulkDelete(keys) { calls.push(`bulkDelete ${keys.length}`); if (fault.bulkDelete) throw new Error("injected: the delete failed"); for (const k of keys) store.delete(k); },
  };
  // A Worker's view. `view` lets one edge location lag: it can return an older value, or null, for a key.
  const binding = (view = (key, value) => value) => ({
    async get(key, type) { const v = view(key, store.get(key) ?? null); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    async put() { throw new Error("a reader never writes builder keys"); },
  });
  return { store, calls, overwrites, fault, client, binding, onWrite: (fn) => { afterWrite = fn; } };
}

const publish = (kv, build, opts = {}) => publishKv(build.entries, { buildId: build.buildId, season, asOfWeek: build.asOfWeek, kv: kv.client, settleMs: 0, log: () => {}, now: () => "2026-10-02T08:25:00.000Z", ...opts });

const ROUTES = ["/api/nfl/meta", "/api/nfl/slate", `/api/nfl/player?id=${LAMAR}`, `/api/nfl/gamelog?id=${LAMAR}`, "/api/nfl/defense?team=BAL", "/api/nfl/injuries?team=BAL", `/api/nfl/research?player=${LAMAR}`];
const collect = (v, key, out = new Set()) => {
  if (Array.isArray(v)) for (const x of v) collect(x, key, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === key && x != null && typeof x !== "object") out.add(x); else collect(x, key, out); }
  return out;
};
async function observe(binding) {
  const out = [];
  for (const path of ROUTES) {
    const url = new URL(`https://pwr-props.com${path}`);
    const res = await handleNflApi(new Request(url), { PROPS_DATA: binding }, url, NOW);
    const body = await res.json();
    out.push({ path, status: res.status, served: res.headers.get("x-nfl-build"), builds: [...collect(body, "build_id")], weeks: [...collect(body, "as_of_week")], body });
  }
  return out;
}
/** Every route answers 200 from exactly one build; returns the builds that answered. */
async function assertEachResponseWhole(binding, allowed, label) {
  const served = new Set();
  for (const r of await observe(binding)) {
    assert.equal(r.status, 200, `${label}: ${r.path} answered ${r.status}`);
    assert.ok(allowed.includes(r.served), `${label}: ${r.path} was served from ${r.served}`);
    assert.deepEqual(r.builds, [r.served === "unversioned" ? "build-A" : r.served], `${label}: ${r.path} carries build ids ${r.builds.join(" and ")}`);
    assert.deepEqual(r.weeks, [WEEK[r.served]], `${label}: ${r.path} mixes as-of weeks ${r.weeks.join(" and ")}`);
    served.add(r.served);
  }
  return [...served];
}
const assertWhole = async (binding, build, label) => assert.deepEqual(await assertEachResponseWhole(binding, [build], label), [build], `${label}: every route is served by ${build}`);

test("a publish writes a build under its own keys, checks it, waits, and only then moves the one pointer", async () => {
  const kv = fakeKv();
  const waits = [];
  await publish(kv, A);
  kv.calls.length = 0;
  const out = await publish(kv, B, { settleMs: undefined, sleep: async (ms) => { waits.push(ms); kv.calls.push("sleep"); } });
  assert.deepEqual(kv.calls, [
    `list ${POINTER_KEY}`, `get ${POINTER_KEY}`,
    `bulkPut ${B.entries.length}`,
    `list ${BUILD_PREFIX}build-B:`, `get ${buildKey("build-B", "nfl:meta")}`,
    "sleep",
    `put ${POINTER_KEY}`, `get ${POINTER_KEY}`,
    `list ${BUILD_PREFIX}`,
  ]);
  assert.deepEqual(waits, [KV_SETTLE_MS]);
  assert.ok(KV_SETTLE_MS > 60_000, "longer than the 60 seconds KV documents for a write to be visible everywhere");
  assert.equal(out.pointer.current.build_id, "build-B");
  assert.equal(out.pointer.previous.build_id, "build-A");
  assert.equal(out.pointer.current.names.length, B.entries.length);
  assert.equal(out.removed, 0, "the build before this one is kept as the fallback");
  for (const e of B.entries) assert.equal(kv.store.get(buildKey("build-B", e.key)), e.value);
});

test("no key a reader is using is ever overwritten: only the pointer changes value", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B); await publish(kv, C);
  assert.deepEqual(kv.overwrites, [POINTER_KEY, POINTER_KEY], "three publishes, two pointer moves, no payload rewritten");
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith(`${BUILD_PREFIX}build-A:`)).length, 0, "the build two back is removed");
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith(`${BUILD_PREFIX}build-B:`)).length, B.entries.length, "the previous build stays");
  assert.ok(![...kv.store.keys()].some((k) => !k.startsWith(BUILD_PREFIX) && k !== POINTER_KEY), "nothing is written outside the build keys and the pointer");
});

test("while a build is being written, after every single key that lands, readers still get the previous build, whole", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  let checked = 0, moved = false;
  kv.onWrite(async (key) => {
    if (key === POINTER_KEY) moved = true;
    await assertWhole(kv.binding(), moved ? "build-B" : "build-A", `after ${key} landed`);
    checked++;
  });
  await publish(kv, B);
  assert.equal(checked, B.entries.length + 1, "checked after each payload and after the pointer");
  assert.equal(moved, true);
});

test("the first versioned publish: readers stay on the unversioned keys until the pointer exists", async () => {
  const kv = fakeKv();
  for (const e of A.entries) kv.store.set(e.key, e.value); // what production holds today
  await assertWhole(kv.binding(), "unversioned", "before");
  let checked = 0;
  kv.onWrite(async (key) => { await assertWhole(kv.binding(), key === POINTER_KEY ? "build-B" : "unversioned", `after ${key} landed`); checked++; });
  const out = await publish(kv, B);
  assert.equal(checked, B.entries.length + 1);
  assert.equal(out.pointer.previous, null);
  for (const e of A.entries) assert.equal(kv.store.get(e.key), e.value, "the unversioned keys are left alone");
});

// ---------- failure injection ----------
const FAILURES = [
  { name: "the bulk write fails before any key lands", inject: (f) => { f.bulkPutDiesAt = 0; }, error: /connection dropped/, orphans: 0 },
  { name: "the bulk write dies half way", inject: (f) => { f.bulkPutDiesAt = 20; }, error: /connection dropped/, orphans: 20 },
  { name: "the bulk write dies on its last key", inject: (f) => { f.bulkPutDiesAt = B.entries.length - 1; }, error: /connection dropped/, orphans: B.entries.length - 1 },
  { name: "the bulk write reports success but one team's payload never landed", inject: (f) => { f.drops = (k) => k.endsWith(":team:BAL"); }, error: /1 of 40 keys of build build-B are not in KV/, orphans: B.entries.length - 1 },
  { name: "the bulk write reports success but a third of the keys never landed", inject: (f) => { let i = 0; f.drops = () => i++ % 3 === 0; }, error: /14 of 40 keys of build build-B are not in KV/, orphans: 26 },
  { name: "the check that the build is complete cannot be made", inject: (f) => { f.list = (p) => p.startsWith(`${BUILD_PREFIX}build-B`); }, error: /list request failed/, orphans: B.entries.length },
  { name: "the build's stamp does not read back", inject: (f) => { f.garbles = (k) => k === buildKey("build-B", "nfl:meta"); }, error: /stamp of build build-B does not read back/, orphans: B.entries.length },
  { name: "the run is killed during the settle wait", inject: () => {}, opts: { settleMs: 1, sleep: async () => { throw new Error("injected: the job was cancelled"); } }, error: /job was cancelled/, orphans: B.entries.length },
  { name: "the pointer write is rejected", inject: (f) => { f.put = "rejected"; }, error: /pointer write was rejected/, orphans: B.entries.length },
];

for (const failure of FAILURES) {
  test(`publish failure: ${failure.name}. Readers keep the previous build, whole, and the next publish recovers`, async () => {
    const kv = fakeKv();
    await publish(kv, A);
    const pointerBefore = kv.store.get(POINTER_KEY);
    failure.inject(kv.fault);
    await assert.rejects(publish(kv, B, failure.opts), failure.error);

    assert.equal(kv.store.get(POINTER_KEY), pointerBefore, "the pointer did not move");
    for (const e of A.entries) assert.equal(kv.store.get(buildKey("build-A", e.key)), e.value, "the previous build is intact");
    assert.equal([...kv.store.keys()].filter((k) => k.startsWith(`${BUILD_PREFIX}build-B:`)).length, failure.orphans, "what did land sits under the failed build's own keys");
    await assertWhole(kv.binding(), "build-A", "after the failure");

    // the next run: a clean publish of a later build
    for (const k of Object.keys(kv.fault)) delete kv.fault[k];
    const out = await publish(kv, C);
    assert.equal(out.pointer.previous.build_id, "build-A", "the failed build never became the previous one");
    assert.equal(out.removed, failure.orphans, "the failed build's leftovers are removed");
    assert.ok(![...kv.store.keys()].some((k) => k.startsWith(`${BUILD_PREFIX}build-B:`)));
    await assertWhole(kv.binding(), "build-C", "after the recovery");
  });
}

test("publish failure: the pointer write lands but the builder is told it failed. Both builds are complete, so readers are whole on either", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  kv.fault.put = "response_lost";
  await assert.rejects(publish(kv, B), /response was lost/);
  assert.equal(JSON.parse(kv.store.get(POINTER_KEY)).current.build_id, "build-B", "the pointer did move");
  await assertWhole(kv.binding(), "build-B", "after the lost response");
  for (const e of A.entries) assert.equal(kv.store.get(buildKey("build-A", e.key)), e.value, "nothing was cleaned up by the failed run");
  delete kv.fault.put;
  const out = await publish(kv, C);
  assert.equal(out.pointer.previous.build_id, "build-B");
  await assertWhole(kv.binding(), "build-C", "after the next publish");
});

test("publish failure: removing older builds fails. The publish still succeeds and the next one cleans up", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  kv.fault.bulkDelete = true;
  const logs = [];
  const out = await publish(kv, C, { log: (m) => logs.push(m) });
  assert.equal(out.removed, 0);
  assert.ok(logs.some((m) => /older builds were not removed/.test(m)));
  await assertWhole(kv.binding(), "build-C", "after the failed cleanup");
  assert.equal([...kv.store.keys()].filter((k) => k.startsWith(`${BUILD_PREFIX}build-A:`)).length, A.entries.length, "build A is still stored");
  delete kv.fault.bulkDelete;
  const D = { ...C, buildId: "build-D", entries: make("build-D", 4, "2026-10-03T08:20:00.000Z").entries };
  const next = await publish(kv, D);
  assert.equal(next.removed, A.entries.length + B.entries.length);
});

// ---------- KV is eventually consistent: one edge location can lag on any key ----------
test("propagation: an edge that still has the old pointer serves the old build, whole", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  const oldPointer = kv.store.get(POINTER_KEY);
  await publish(kv, B);
  await assertWhole(kv.binding((key, value) => (key === POINTER_KEY ? oldPointer : value)), "build-A", "stale pointer");
  await assertWhole(kv.binding(), "build-B", "current pointer");
});

test("propagation: an edge that has the new pointer before one of the new payloads answers that request from the previous build, never from both", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  const fellBack = [];
  for (const e of B.entries) {
    const lagging = buildKey("build-B", e.key);
    const served = await assertEachResponseWhole(kv.binding((key, value) => (key === lagging ? null : value)), ["build-A", "build-B"], `${e.key} not at this edge yet`);
    if (served.includes("build-A")) fellBack.push(e.key);
  }
  // exactly the payloads the checked routes read; a lag on any other key changes nothing for them
  assert.deepEqual(fellBack.sort(), ["nfl:defense:2026:4", "nfl:defense:current", "nfl:meta", "nfl:players:index", "nfl:slate:current", "nfl:status:latest", "nfl:team:BAL"]);
  // the routes that never touch the missing key are unaffected
  const others = await observe(kv.binding((key, value) => (key === buildKey("build-B", "nfl:team:KC") ? null : value)));
  assert.ok(others.every((r) => r.served === "build-B" && r.status === 200));
});

test("propagation: with the current and the previous build both unreadable, a request fails with 503 and no data, never a partial payload", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  const gone = (key, value) => (key.endsWith(":team:BAL") ? null : value);
  const seen = await observe(kv.binding(gone));
  const byPath = Object.fromEntries(seen.map((r) => [r.path.split("?")[0], r]));
  for (const p of ["/api/nfl/player", "/api/nfl/gamelog", "/api/nfl/research"]) {
    assert.equal(byPath[p].status, 503);
    assert.deepEqual(Object.keys(byPath[p].body), ["error"]);
  }
  for (const p of ["/api/nfl/meta", "/api/nfl/slate", "/api/nfl/defense", "/api/nfl/injuries"]) assert.equal(byPath[p].status, 200, `${p} does not need that key`);
});

test("the odds refresh takes the slate and the rosters from one build", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  const env = (binding) => ({ PROPS_DATA: binding, SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true" });
  let requests = 0;
  const fetchImpl = async () => { requests++; return { ok: true, status: 200, json: async () => ({ data: [], pagination: { has_more: false } }) }; };
  // this edge lacks build B's rosters: the refresh must not pair B's slate with A's rosters
  const lagging = kv.binding((key, value) => (key === buildKey("build-B", "nfl:rosters:current") ? null : value));
  assert.deepEqual(await refreshNflOdds(env(lagging), { now: NOW, fetchImpl }), { skipped: "no_pregame_games" }, "it used build A's slate (Week 3, already played) with build A's rosters");
  assert.equal(requests, 0);
  const none = kv.binding((key, value) => (key.endsWith(":rosters:current") ? null : value));
  assert.deepEqual(await refreshNflOdds(env(none), { now: NOW, fetchImpl }), { skipped: "snapshot_unavailable" });
  assert.equal(requests, 0, "no provider request is spent when the build cannot be read");
});

test("the publisher refuses keys outside its namespace, reserved keys, and a pointer it cannot read", async () => {
  const kv = fakeKv();
  const opts = { buildId: "build-X", season, asOfWeek: 4, kv: kv.client, settleMs: 0, log: () => {} };
  await assert.rejects(publishKv([...B.entries, { key: "odds:latest", value: "{}" }], opts), /refusing to publish non-NFL KV keys: odds:latest/);
  await assert.rejects(publishKv([...B.entries, { key: "nfl:odds:latest", value: "{}" }], opts), /reserved KV keys: nfl:odds:latest/);
  await assert.rejects(publishKv([...B.entries, { key: POINTER_KEY, value: "{}" }], opts), /reserved KV keys/);
  await assert.rejects(publishKv(B.entries, { ...opts, buildId: "2026:bad" }), /cannot be used in a KV key/);
  await assert.rejects(publishKv(B.entries.filter((e) => e.key !== "nfl:meta"), opts), /no nfl:meta payload/);
  assert.equal(kv.store.size, 0, "none of these wrote anything");
  await publish(kv, A);
  await assert.rejects(publish(kv, A), /already the live build/);
  kv.store.set(POINTER_KEY, "not json");
  await assert.rejects(publish(kv, B), /exists but cannot be read; nothing was changed/);
  assert.ok(![...kv.store.keys()].some((k) => k.startsWith(`${BUILD_PREFIX}build-B:`)));
});
