// Publishing a build to KV: what readers observe while it is being written,
// when it fails part of the way, while it is still spreading to the edge, and
// after later builds have been published on top of it.
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
import { publishKv, buildTime, KV_SETTLE_MS, BUILD_RETENTION_MS } from "../etl/nfl/publish.mjs";
import { handleNflApi } from "../src/nfl/api.js";
import { refreshNflOdds } from "../src/nfl/odds.js";
import { localD1 } from "../etl/nfl/local-d1.mjs";
import { POINTER_KEY, BUILD_PREFIX, buildKey } from "../src/nfl/snapshot.js";

const { season, source } = loadSource();
const NOW = Date.parse("2026-10-02T09:00:00Z");
const LAMAR = "00-0034796";
const T0 = Date.parse("2026-10-01T08:20:00Z");
const MIN = 60000, HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
// build ids carry their build time, as the builder's do
const idAt = (ms) => `2026-${iso(ms).replace(/[-:]/g, "").slice(0, 15)}Z`;

// Real builds from the 2026 fixture. They differ in content, not just in name:
// A is the state entering Week 3, the others the state entering Week 4.
const WEEK = { unversioned: 3 };
const make = (builtMs, asOfWeek) => {
  const buildId = idAt(builtMs);
  const payloads = buildPayloads(deriveAll({ season, source, asOfWeek, capturedDate: iso(builtMs).slice(0, 10), buildId, builtAt: iso(builtMs) }).derived);
  WEEK[buildId] = asOfWeek;
  return { buildId, builtMs, asOfWeek, payloads, entries: Object.entries(payloads).map(([key, value]) => ({ key, value: JSON.stringify(value) })) };
};
const A = make(T0, 3);
const B = make(T0 + 10 * MIN, 4);
const C = make(T0 + 20 * MIN, 4);
// the same payloads under a later build id: for publishes days apart
const later = (build, builtMs) => { const buildId = idAt(builtMs); WEEK[buildId] = build.asOfWeek; return { ...build, buildId, builtMs, entries: build.entries.map((e) => ({ key: e.key, value: e.value.split(`"${build.buildId}"`).join(`"${buildId}"`) })) }; };
const N = B.entries.length;

/** One KV namespace, seen by the publisher (client) and by a Worker at an edge (binding). */
function fakeKv() {
  const store = new Map();
  const calls = [], overwrites = [], fault = {};
  let afterWrite = null;
  const set = async (k, v) => { if (store.has(k)) overwrites.push(k); store.set(k, v); if (afterWrite) await afterWrite(k); };
  const client = {
    async list(prefix) { calls.push(`list ${prefix}`); if (fault.list?.(prefix)) throw new Error("injected: the list request failed"); return [...store.keys()].filter((k) => k.startsWith(prefix)); },
    async get(key) { calls.push(`get ${key}`); if (!store.has(key)) throw new Error("404 not found"); if (fault.garbles?.(key)) return "<html>502 bad gateway</html>"; return fault.reads?.(key, store.get(key)) ?? store.get(key); },
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
  const keysOf = (build) => [...store.keys()].filter((k) => k.startsWith(`${BUILD_PREFIX}${build.buildId}:`)).length;
  return { store, calls, overwrites, fault, client, binding, keysOf, onWrite: (fn) => { afterWrite = fn; } };
}

// each publish happens two minutes after its build was made, unless a test says when
const publish = (kv, build, opts = {}) => publishKv(build.entries, { buildId: build.buildId, season, asOfWeek: build.asOfWeek, kv: kv.client, settleMs: 0, log: () => {}, now: () => iso(build.builtMs + 2 * MIN), ...opts });

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
    assert.deepEqual(r.builds, [r.served === "unversioned" ? A.buildId : r.served], `${label}: ${r.path} carries build ids ${r.builds.join(" and ")}`);
    assert.deepEqual(r.weeks, [WEEK[r.served]], `${label}: ${r.path} mixes as-of weeks ${r.weeks.join(" and ")}`);
    served.add(r.served);
  }
  return [...served];
}
const assertWhole = async (binding, build, label) => assert.deepEqual(await assertEachResponseWhole(binding, [build], label), [build], `${label}: every route is served by ${build}`);

test("a publish writes a build under its own keys, checks it, waits, reads the pointer again, and only then moves it", async () => {
  const kv = fakeKv();
  const waits = [];
  await publish(kv, A);
  kv.calls.length = 0;
  const out = await publish(kv, B, { settleMs: undefined, sleep: async (ms) => { waits.push(ms); kv.calls.push("sleep"); } });
  assert.deepEqual(kv.calls, [
    `list ${POINTER_KEY}`, `get ${POINTER_KEY}`,
    `bulkPut ${N}`,
    `list ${BUILD_PREFIX}${B.buildId}:`, `get ${buildKey(B.buildId, "nfl:meta")}`,
    "sleep",
    `list ${POINTER_KEY}`, `get ${POINTER_KEY}`,
    `put ${POINTER_KEY}`, `get ${POINTER_KEY}`,
    `list ${BUILD_PREFIX}`,
  ]);
  assert.deepEqual(waits, [KV_SETTLE_MS]);
  assert.ok(KV_SETTLE_MS > 60_000, "longer than the 60 seconds KV documents for a write to be visible everywhere");
  assert.equal(out.pointer.schema, 2);
  assert.equal(out.pointer.current.build_id, B.buildId);
  assert.equal(out.pointer.previous.build_id, A.buildId);
  assert.deepEqual(out.pointer.retained.map((b) => [b.build_id, b.superseded_at]), [[A.buildId, iso(B.builtMs + 2 * MIN)]], "the pointer records when each older build stopped being current");
  assert.equal(out.pointer.current.names.length, N);
  assert.equal(out.removed, 0);
  for (const e of B.entries) assert.equal(kv.store.get(buildKey(B.buildId, e.key)), e.value);
});

test("no key a reader is using is ever overwritten: only the pointer changes value", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B); await publish(kv, C);
  assert.deepEqual(kv.overwrites, [POINTER_KEY, POINTER_KEY], "three publishes, two pointer moves, no payload rewritten");
  assert.ok(![...kv.store.keys()].some((k) => !k.startsWith(BUILD_PREFIX) && k !== POINTER_KEY), "nothing is written outside the build keys and the pointer");
  assert.ok(!kv.calls.some((c) => c.startsWith("bulkDelete")), "and nothing is deleted");
});

test("while a build is being written, after every single key that lands, readers still get the previous build, whole", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  let checked = 0, moved = false;
  kv.onWrite(async (key) => {
    if (key === POINTER_KEY) moved = true;
    await assertWhole(kv.binding(), moved ? B.buildId : A.buildId, `after ${key} landed`);
    checked++;
  });
  await publish(kv, B);
  assert.equal(checked, N + 1, "checked after each payload and after the pointer");
  assert.equal(moved, true);
});

test("the first versioned publish: readers stay on the unversioned keys until the pointer exists, and those keys are left alone", async () => {
  const kv = fakeKv();
  for (const e of A.entries) kv.store.set(e.key, e.value); // what production holds today
  await assertWhole(kv.binding(), "unversioned", "before");
  let checked = 0;
  kv.onWrite(async (key) => { await assertWhole(kv.binding(), key === POINTER_KEY ? B.buildId : "unversioned", `after ${key} landed`); checked++; });
  const out = await publish(kv, B);
  assert.equal(checked, N + 1);
  assert.equal(out.pointer.previous, null);
  assert.deepEqual(out.pointer.retained, []);
  for (const e of A.entries) assert.equal(kv.store.get(e.key), e.value, "the unversioned keys are untouched, so the Worker version before this one still works if it is rolled back to");
});

// ---------- failure injection ----------
const FAILURES = [
  { name: "the bulk write fails before any key lands", inject: (f) => { f.bulkPutDiesAt = 0; }, error: /connection dropped/, orphans: 0 },
  { name: "the bulk write dies half way", inject: (f) => { f.bulkPutDiesAt = 20; }, error: /connection dropped/, orphans: 20 },
  { name: "the bulk write dies on its last key", inject: (f) => { f.bulkPutDiesAt = N - 1; }, error: /connection dropped/, orphans: N - 1 },
  { name: "the bulk write reports success but one team's payload never landed", inject: (f) => { f.drops = (k) => k.endsWith(":team:BAL"); }, error: /1 of 40 keys of build \S+ are not in KV/, orphans: N - 1 },
  { name: "the bulk write reports success but a third of the keys never landed", inject: (f) => { let i = 0; f.drops = () => i++ % 3 === 0; }, error: /14 of 40 keys of build \S+ are not in KV/, orphans: 26 },
  { name: "the check that the build is complete cannot be made", inject: (f) => { f.list = (p) => p.startsWith(`${BUILD_PREFIX}${B.buildId}`); }, error: /list request failed/, orphans: N },
  { name: "the build's stamp does not read back", inject: (f) => { f.garbles = (k) => k === buildKey(B.buildId, "nfl:meta"); }, error: /stamp of build \S+ does not read back/, orphans: N },
  { name: "the run is killed during the settle wait", inject: () => {}, opts: { settleMs: 1, sleep: async () => { throw new Error("injected: the job was cancelled"); } }, error: /job was cancelled/, orphans: N },
  { name: "the pointer write is rejected", inject: (f) => { f.put = "rejected"; }, error: /pointer write was rejected/, orphans: N },
];

for (const failure of FAILURES) {
  test(`publish failure: ${failure.name}. Readers keep the previous build, whole, and the next publish recovers`, async () => {
    const kv = fakeKv();
    await publish(kv, A);
    const pointerBefore = kv.store.get(POINTER_KEY);
    failure.inject(kv.fault);
    await assert.rejects(publish(kv, B, failure.opts), failure.error);

    assert.equal(kv.store.get(POINTER_KEY), pointerBefore, "the pointer did not move");
    for (const e of A.entries) assert.equal(kv.store.get(buildKey(A.buildId, e.key)), e.value, "the previous build is intact");
    assert.equal(kv.keysOf(B), failure.orphans, "what did land sits under the failed build's own keys");
    await assertWhole(kv.binding(), A.buildId, "after the failure");

    // the next run: a clean publish of a later build
    for (const k of Object.keys(kv.fault)) delete kv.fault[k];
    const out = await publish(kv, C);
    assert.equal(out.pointer.previous.build_id, A.buildId, "the failed build never became the previous one");
    assert.ok(!out.pointer.retained.some((b) => b.build_id === B.buildId), "and is not listed anywhere in the pointer");
    assert.equal(kv.keysOf(B), failure.orphans, "its leftovers are not deleted while they are young: another publisher could be the one writing them");
    await assertWhole(kv.binding(), C.buildId, "after the recovery");
    // two days on they are old enough to go
    const D = later(C, T0 + 49 * HOUR);
    await publish(kv, D);
    assert.equal(kv.keysOf(B), 0, "the failed build's leftovers are removed once they are past retention");
    await assertWhole(kv.binding(), D.buildId, "two days later");
  });
}

test("publish failure: the pointer write lands but the builder is told it failed. Both builds are complete, so readers are whole on either", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  kv.fault.put = "response_lost";
  await assert.rejects(publish(kv, B), /response was lost/);
  assert.equal(JSON.parse(kv.store.get(POINTER_KEY)).current.build_id, B.buildId, "the pointer did move");
  await assertWhole(kv.binding(), B.buildId, "after the lost response");
  assert.equal(kv.keysOf(A), N, "nothing was cleaned up by the failed run");
  delete kv.fault.put;
  const out = await publish(kv, C);
  assert.deepEqual(out.pointer.retained.map((b) => b.build_id), [B.buildId, A.buildId]);
  await assertWhole(kv.binding(), C.buildId, "after the next publish");
});

test("publish failure: removing builds past retention fails. The publish still succeeds and the next one cleans up", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  const D = later(C, T0 + 49 * HOUR), E = later(C, T0 + 50 * HOUR);
  kv.fault.bulkDelete = true;
  const logs = [];
  const out = await publish(kv, D, { log: (m) => logs.push(m) });
  assert.equal(out.removed, 0);
  assert.ok(logs.some((m) => /older builds were not removed/.test(m)));
  await assertWhole(kv.binding(), D.buildId, "after the failed cleanup");
  assert.equal(kv.keysOf(A), N, "build A is still stored");
  delete kv.fault.bulkDelete;
  const next = await publish(kv, E);
  assert.equal(next.removed, N, "build A, superseded two days ago, goes on the next publish");
  assert.equal(kv.keysOf(A), 0);
  assert.equal(kv.keysOf(B), N, "build B was current until an hour ago and stays");
});

// ---------- retention: what readers on an older pointer still find ----------
test("A, then B, then C within minutes: a reader still on the A pointer, or on any pointer's fallback, is served whole", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  const pointerA = kv.store.get(POINTER_KEY);
  await publish(kv, B);
  const pointerB = kv.store.get(POINTER_KEY);
  const out = await publish(kv, C);
  assert.equal(out.removed, 0, "the cleanup right after a pointer change deletes nothing a reader could be on");
  assert.deepEqual([kv.keysOf(A), kv.keysOf(B), kv.keysOf(C)], [N, N, N]);
  assert.deepEqual(out.pointer.retained.map((b) => b.build_id), [B.buildId, A.buildId]);

  const stale = (pointer, lagging) => kv.binding((key, value) => (key === POINTER_KEY ? pointer : key === lagging ? null : value));
  // two pointer changes behind
  await assertWhole(stale(pointerA), A.buildId, "an edge still holding the A pointer");
  // one behind
  await assertWhole(stale(pointerB), B.buildId, "an edge still holding the B pointer");
  // one behind AND missing one of its own payloads: its fallback, A, must still be there
  for (const name of ["nfl:team:BAL", "nfl:slate:current", "nfl:meta"]) {
    const served = await assertEachResponseWhole(stale(pointerB, buildKey(B.buildId, name)), [A.buildId, B.buildId], `B pointer, ${name} not at this edge`);
    assert.ok(served.includes(A.buildId), "the routes that need the missing payload were answered from A, complete");
  }
  // current pointer, missing a payload: fallback B
  const served = await assertEachResponseWhole(kv.binding((key, value) => (key === buildKey(C.buildId, "nfl:team:BAL") ? null : value)), [B.buildId, C.buildId], "C pointer, one payload not at this edge");
  assert.ok(served.includes(B.buildId));
});

test("a build's keys are deleted only after it has been superseded for the retention time, and the fallback build is never deleted", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  const pointerA = kv.store.get(POINTER_KEY);
  await publish(kv, B); await publish(kv, C);
  assert.equal(BUILD_RETENTION_MS, 48 * HOUR);

  // 47 hours on: A was superseded 46h50m ago. Nothing goes.
  const D = later(C, T0 + 47 * HOUR);
  assert.equal((await publish(kv, D)).removed, 0);
  await assertWhole(kv.binding((key, value) => (key === POINTER_KEY ? pointerA : value)), A.buildId, "a reader on a pointer 47 hours old");

  // 49 hours on: A and B were superseded more than 48 hours ago; C two hours ago; D is the fallback.
  const E = later(C, T0 + 49 * HOUR);
  const out = await publish(kv, E);
  assert.equal(out.removed, 2 * N);
  assert.deepEqual([kv.keysOf(A), kv.keysOf(B), kv.keysOf(C), kv.keysOf(D), kv.keysOf(E)], [0, 0, N, N, N]);
  assert.deepEqual(out.pointer.retained.map((b) => b.build_id), [D.buildId, C.buildId]);
  assert.equal(out.pointer.previous.build_id, D.buildId);
  // beyond the guarantee the answer is an error, never a mixture
  const seen = await observe(kv.binding((key, value) => (key === POINTER_KEY ? pointerA : value)));
  assert.ok(seen.every((r) => r.status === 503 && Object.keys(r.body).join() === "error"), "a pointer older than the retention time gets 503 on every route, not part of a newer build");
});

test("the build before the live one is kept however old it is", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  const B10 = later(B, T0 + 240 * HOUR);
  const first = await publish(kv, B10);
  assert.equal(first.removed, 0);
  assert.equal(kv.keysOf(A), N, "ten days old, and still the fallback");
  const C20 = later(C, T0 + 480 * HOUR);
  const second = await publish(kv, C20);
  assert.equal(kv.keysOf(A), 0, "superseded ten days ago and no longer the fallback: removed");
  assert.equal(kv.keysOf(B10), N);
  assert.equal(second.pointer.previous.build_id, B10.buildId);
});

test("a build no pointer lists is removed only by its own age; one whose id carries no time is never removed", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  kv.fault.bulkPutDiesAt = 20;
  await assert.rejects(publish(kv, B), /connection dropped/);
  delete kv.fault.bulkPutDiesAt;
  kv.store.set(`${BUILD_PREFIX}manual-test:meta`, "{}");
  assert.ok(Number.isNaN(buildTime("manual-test")));
  assert.equal(buildTime(A.buildId), T0);
  const logs = [];
  await publish(kv, C, { log: (m) => logs.push(m) });
  assert.equal(kv.keysOf(B), 20);
  assert.ok(logs.some((m) => /2 unlisted build\(s\) kept/.test(m)), "kept, and said so");
  await publish(kv, later(C, T0 + 49 * HOUR));
  assert.equal(kv.keysOf(B), 0);
  assert.ok(kv.store.has(`${BUILD_PREFIX}manual-test:meta`), "no time in the id: left for a person to remove");
});

test("two publishers at once: the later pointer is built on the earlier one, nothing either wrote is deleted, and readers on either pointer are whole", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  // P2 (build C) starts first and is held in its settle wait while P1 (build B) publishes completely
  let release;
  const gate = new Promise((r) => { release = r; });
  const p2 = publish(kv, C, { settleMs: 1, sleep: () => gate });
  await new Promise((r) => setTimeout(r, 5));
  await publish(kv, B);
  const pointerB = kv.store.get(POINTER_KEY);
  release();
  const out = await p2;
  assert.equal(out.pointer.previous.build_id, B.buildId, "P2 read the pointer again after its wait and went on top of B, not on top of what it saw at the start");
  assert.deepEqual(out.pointer.retained.map((b) => b.build_id), [B.buildId, A.buildId]);
  assert.deepEqual([kv.keysOf(A), kv.keysOf(B), kv.keysOf(C)], [N, N, N]);
  await assertWhole(kv.binding(), C.buildId, "current pointer");
  await assertWhole(kv.binding((key, value) => (key === POINTER_KEY ? pointerB : value)), B.buildId, "an edge on P1's pointer");
});

test("two publishers at once, the unlucky interleaving: P2 writes a pointer that does not know about P1's build. That build is still kept", async () => {
  const kv = fakeKv();
  await publish(kv, A);
  const pointerA = kv.store.get(POINTER_KEY);
  await publish(kv, B);
  const pointerB = kv.store.get(POINTER_KEY);
  // P2's two pointer reads both return what was live before P1's write became visible to it
  let pointerReads = 0;
  kv.fault.reads = (key) => (key === POINTER_KEY && ++pointerReads <= 2 ? pointerA : undefined);
  const out = await publish(kv, C);
  delete kv.fault.reads;
  assert.equal(out.pointer.previous.build_id, A.buildId);
  assert.ok(!out.pointer.retained.some((b) => b.build_id === B.buildId), "P2's pointer does not list B");
  assert.equal(kv.keysOf(B), N, "B is unlisted and young, so it is not deleted");
  await assertWhole(kv.binding((key, value) => (key === POINTER_KEY ? pointerB : value)), B.buildId, "an edge still on P1's pointer");
  await assertWhole(kv.binding(), C.buildId, "current pointer");
});

// ---------- KV is eventually consistent: one edge location can lag on any key ----------
test("propagation: an edge that has the new pointer before one of the new payloads answers that request from the previous build, never from both", async () => {
  const kv = fakeKv();
  await publish(kv, A); await publish(kv, B);
  const fellBack = [];
  for (const e of B.entries) {
    const lagging = buildKey(B.buildId, e.key);
    const served = await assertEachResponseWhole(kv.binding((key, value) => (key === lagging ? null : value)), [A.buildId, B.buildId], `${e.key} not at this edge yet`);
    if (served.includes(A.buildId)) fellBack.push(e.key);
  }
  // exactly the payloads the checked routes read; a lag on any other key changes nothing for them
  assert.deepEqual(fellBack.sort(), ["nfl:defense:2026:4", "nfl:defense:current", "nfl:meta", "nfl:players:index", "nfl:slate:current", "nfl:status:latest", "nfl:team:BAL"]);
  const others = await observe(kv.binding((key, value) => (key === buildKey(B.buildId, "nfl:team:KC") ? null : value)));
  assert.ok(others.every((r) => r.served === B.buildId && r.status === 200));
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
  const db = await localD1();
  const env = (binding) => ({ PROPS_DATA: binding, NFL_DB: db, SHARPAPI_KEY: "k", NFL_ODDS_ENABLED: "true" });
  let requests = 0;
  const fetchImpl = async () => { requests++; return { ok: true, status: 200, json: async () => ({ data: [], pagination: { has_more: false } }) }; };
  // this edge lacks build B's rosters: the refresh must not pair B's slate with A's rosters
  const lagging = kv.binding((key, value) => (key === buildKey(B.buildId, "nfl:rosters:current") ? null : value));
  assert.deepEqual(await refreshNflOdds(env(lagging), { now: NOW, fetchImpl }), { skipped: "no_pregame_games" }, "it used build A's slate (Week 3, already played) with build A's rosters");
  assert.equal(requests, 0);
  const none = kv.binding((key, value) => (key.endsWith(":rosters:current") ? null : value));
  assert.deepEqual(await refreshNflOdds(env(none), { now: NOW + 10 * MIN, fetchImpl }), { skipped: "snapshot_unavailable" });
  assert.equal(requests, 0, "no provider request is spent when the build cannot be read");
  assert.deepEqual((await db.prepare("SELECT kind, reason FROM nfl_odds_runs ORDER BY started_at").all()).results.map((r) => `${r.kind}:${r.reason}`), ["skip:no_pregame_games", "skip:snapshot_unavailable"], "both skips are on the run ledger");
});

test("the publisher refuses keys outside its namespace, reserved keys, and a pointer it cannot read", async () => {
  const kv = fakeKv();
  const opts = { buildId: idAt(T0 + 30 * MIN), season, asOfWeek: 4, kv: kv.client, settleMs: 0, log: () => {} };
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
  assert.equal(kv.keysOf(B), 0);
});
