// The source archive: every object a build points at is read back from R2 and
// checked against the SHA-256 recorded at download, and no data reaches D1 or
// KV unless that worked. Runs against an in-memory R2 stand-in with injected
// failures; nothing here touches the account.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { archiveSources } from "../etl/nfl/publish.mjs";
import { runPublish, archivePlan } from "../etl/nfl/build.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const BUILD = "2026-20261009T082000Z";

/** Source files as the builder writes them, and the list archiveSources receives. */
function sources(dir) {
  const datasets = ["schedule", "pbp", "stats_player_week", "stats_team_week", "roster_weekly", "injuries", "depth_charts"];
  return datasets.map((dataset, i) => {
    const bytes = Buffer.from(`${dataset} bytes ${i} `.repeat(200 + i));
    const path = join(dir, `${dataset}.csv.gz`);
    writeFileSync(path, bytes);
    return { dataset, season: 2026, sha256: sha(bytes), key: `nflverse/2026/${BUILD}/${dataset}.csv.gz`, path };
  });
}

/** A private bucket in memory. `fault` decides what goes wrong. */
function fakeR2() {
  const objects = new Map(), calls = [], fault = {};
  return {
    objects, calls, fault,
    async put(key, path) {
      calls.push(`put ${key}`);
      if (fault.put?.(key)) throw Object.assign(new Error("Command failed"), { stderr: "X [ERROR] A request to the Cloudflare API failed. [code: 10001]" });
      objects.set(key, fault.corrupt?.(key) ? Buffer.from("not the file") : readFileSync(path));
    },
    async get(key, dest) {
      calls.push(`get ${key}`);
      if (fault.get?.(key)) throw new Error("The specified key does not exist.");
      if (!objects.has(key)) throw new Error("The specified key does not exist.");
      writeFileSync(dest, objects.get(key));
    },
  };
}

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "nfl-archive-"));
  const files = sources(dir);
  const opts = (r2, extra = {}) => ({ r2, tmpDir: join(dir, "readback"), manifestKey: `nflverse/2026/${BUILD}/manifest.json`, manifest: (keys) => ({ build_id: BUILD, sources: files.map((f) => ({ dataset: f.dataset, sha256: f.sha256, archive_key: keys.get(f.dataset) })) }), log: () => {}, ...extra });
  return { dir, files, opts, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test("every source file is uploaded, read back from R2 and checked, then the manifest", async () => {
  const { files, opts, dir, done } = setup();
  try {
    const r2 = fakeR2();
    const out = await archiveSources(files, new Map(), opts(r2));
    assert.deepEqual(out.failures, []);
    assert.deepEqual([out.uploaded, out.reused, out.verified], [7, 0, 8], "7 files and the manifest, each read back");
    for (const f of files) {
      assert.equal(out.keys.get(f.dataset), f.key);
      assert.equal(sha(r2.objects.get(f.key)), f.sha256, "the bytes in the bucket are the bytes downloaded");
    }
    assert.equal(out.manifestKey, `nflverse/2026/${BUILD}/manifest.json`);
    const manifest = JSON.parse(r2.objects.get(out.manifestKey));
    assert.deepEqual(manifest.sources.map((s) => s.archive_key), files.map((f) => f.key), "the manifest names each file's archive key");
    // order: each object is read back right after it is written; the manifest goes last
    assert.deepEqual(r2.calls.slice(0, 2), [`put ${files[0].key}`, `get ${files[0].key}`]);
    assert.deepEqual(r2.calls.slice(-2), [`put ${out.manifestKey}`, `get ${out.manifestKey}`]);
    assert.deepEqual(readdirSync(join(dir, "readback")).filter((n) => n.startsWith("readback-")), [], "read-back copies are deleted");
  } finally { done(); }
});

const FAILURES = [
  ["the upload is refused", (f, files) => { f.put = (k) => k === files[1].key; }, /pbp: .*10001/],
  ["the upload reports success but the object is not there", (f, files) => { f.get = (k) => k === files[2].key; }, /stats_player_week: .*does not exist/],
  ["the object in R2 is not the file that was downloaded", (f, files) => { f.corrupt = (k) => k === files[3].key; }, /stats_team_week: .*read back with SHA-256/],
];
for (const [name, inject, reason] of FAILURES) {
  test(`archive failure: ${name}. It is reported, the file gets no archive key, and the manifest is not written`, async () => {
    const { files, opts, done } = setup();
    try {
      const r2 = fakeR2();
      inject(r2.fault, files);
      const out = await archiveSources(files, new Map(), opts(r2));
      assert.equal(out.failures.length, 1);
      assert.match(`${out.failures[0].dataset}: ${out.failures[0].reason}`, reason);
      assert.equal(out.keys.get(out.failures[0].dataset), null);
      assert.equal(out.manifestKey, null);
      assert.ok(!r2.calls.some((c) => c.includes("manifest.json")), "an incomplete archive gets no manifest");
      assert.equal(out.uploaded, 6, "the other files are still archived and checked");
    } finally { done(); }
  });
}

test("archive failure: the local file changed after download. It is caught before anything is uploaded", async () => {
  const { files, opts, done } = setup();
  try {
    writeFileSync(files[4].path, "tampered");
    const r2 = fakeR2();
    const out = await archiveSources(files, new Map(), opts(r2));
    assert.deepEqual(out.failures.map((x) => x.dataset), ["roster_weekly"]);
    assert.match(out.failures[0].reason, /no longer matches the SHA-256 recorded at download/);
    assert.ok(!r2.calls.includes(`put ${files[4].key}`));
  } finally { done(); }
});

test("an unchanged file is not uploaded again, but the archived copy it points at is read back and checked", async () => {
  const { files, opts, done } = setup();
  try {
    const r2 = fakeR2();
    const first = await archiveSources(files, new Map(), opts(r2));
    const archived = new Map(files.map((f) => [`${f.dataset}|2026`, { sha256: f.sha256, archive_key: first.keys.get(f.dataset) }]));
    // the next build: same bytes, new build id in the key
    const next = files.map((f) => ({ ...f, key: f.key.replace(BUILD, "2026-20261010T082000Z") }));
    r2.calls.length = 0;
    const out = await archiveSources(next, archived, opts(r2, { manifestKey: "nflverse/2026/2026-20261010T082000Z/manifest.json" }));
    assert.deepEqual([out.uploaded, out.reused, out.failures.length], [0, 7, 0]);
    assert.ok(files.every((f) => out.keys.get(f.dataset) === f.key), "the build points at the existing objects");
    assert.deepEqual(r2.calls.filter((c) => c.startsWith("put")), ["put nflverse/2026/2026-20261010T082000Z/manifest.json"], "only the new manifest is written");
    assert.equal(r2.calls.filter((c) => c.startsWith("get")).length, 8, "and every object it points at was read back");
  } finally { done(); }
});

test("an archived copy that has gone missing or changed is not trusted: the file is uploaded again under this build", async () => {
  const { files, opts, done } = setup();
  try {
    const r2 = fakeR2();
    const first = await archiveSources(files, new Map(), opts(r2));
    const archived = new Map(files.map((f) => [`${f.dataset}|2026`, { sha256: f.sha256, archive_key: first.keys.get(f.dataset) }]));
    r2.objects.delete(files[0].key);                       // gone
    r2.objects.set(files[1].key, Buffer.from("rotted"));    // changed
    const next = files.map((f) => ({ ...f, key: f.key.replace(BUILD, "2026-20261010T082000Z") }));
    const logs = [];
    const out = await archiveSources(next, archived, opts(r2, { manifestKey: "m2.json", log: (m) => logs.push(m) }));
    assert.deepEqual([out.uploaded, out.reused, out.failures.length], [2, 5, 0]);
    assert.equal(out.keys.get("schedule"), next[0].key);
    assert.equal(out.keys.get("pbp"), next[1].key);
    assert.equal(logs.filter((m) => /did not verify .* uploading it again/.test(m)).length, 2);
  } finally { done(); }
});

test("the manifest itself must verify, or the archive is incomplete", async () => {
  const { files, opts, done } = setup();
  try {
    const r2 = fakeR2();
    r2.fault.corrupt = (k) => k.endsWith("manifest.json");
    const out = await archiveSources(files, new Map(), opts(r2));
    assert.deepEqual(out.failures.map((x) => x.dataset), ["manifest"]);
    assert.equal(out.manifestKey, null);
  } finally { done(); }
});

// ---------- the publish sequence ----------
const steps = (archiveResult) => {
  const calls = [];
  return {
    calls,
    archive: async () => { calls.push("archive"); if (archiveResult instanceof Error) throw archiveResult; return archiveResult; },
    prepare: async (a) => { calls.push(`prepare:${a ? a.manifestKey : "none"}`); return { sqlFile: "d1.sql", payloads: {} }; },
    d1: async () => { calls.push("d1"); },
    kv: async () => { calls.push("kv"); },
  };
};
const good = { failures: [], manifestKey: "m.json", keys: new Map(), uploaded: 7, reused: 0 };

test("the publish runs archive, then D1, then KV, and the data carries the verified archive", async () => {
  const s = steps(good);
  const out = await runPublish(["r2", "d1", "kv"], {}, s);
  assert.deepEqual(s.calls, ["archive", "prepare:m.json", "d1", "kv"]);
  assert.equal(out.stopped, undefined);
});

for (const [name, result] of [
  ["one file did not verify", { ...good, failures: [{ dataset: "pbp", reason: "x" }] }],
  ["the manifest was not archived", { ...good, manifestKey: null }],
  ["the archive step returned nothing", null],
]) {
  test(`publication cannot proceed when ${name}: D1 and KV are never called`, async () => {
    const s = steps(result);
    const out = await runPublish(["r2", "d1", "kv"], {}, s);
    assert.equal(out.stopped, "archive_failed");
    assert.deepEqual(s.calls, ["archive"]);
  });
}

test("publication cannot proceed when the archive step throws", async () => {
  const s = steps(new Error("R2 is not enabled [code: 10042]"));
  await assert.rejects(runPublish(["r2", "d1", "kv"], {}, s), /10042/);
  assert.deepEqual(s.calls, ["archive"]);
});

test("D1 or KV without r2 is refused before anything runs; there is no override", async () => {
  for (const publish of [["d1"], ["kv"], ["d1", "kv"]]) {
    const s = steps(good);
    assert.deepEqual(await runPublish(publish, {}, s), { stopped: "archive_required" });
    assert.deepEqual(s.calls, [], `${publish.join(",")}: nothing ran`);
  }
  const s = steps(good);
  assert.deepEqual(await runPublish(["d1", "kv"], { archivePending: true }, s), { stopped: "archive_required" }, "an old 'pending' option is ignored");
  assert.equal(archivePlan(["d1", "kv"], { archivePending: true }).refuse, true);
});

test("archive only (--publish r2) archives and verifies and writes no data; a local KV rehearsal needs no archive", async () => {
  const s = steps(good);
  await runPublish(["r2"], {}, s);
  assert.deepEqual(s.calls, ["archive", "prepare:m.json"]);
  const local = steps(good);
  await runPublish(["kv"], { kvLocal: true }, local);
  assert.deepEqual(local.calls, ["prepare:none", "kv"]);
  const none = steps(good);
  await runPublish([], {}, none);
  assert.deepEqual(none.calls, ["prepare:none"], "a plain build writes its local outputs and publishes nothing");
});

test("the builder's command line goes through runPublish: the only D1 and KV calls are inside its steps", () => {
  const build = readFileSync(new URL("../etl/nfl/build.mjs", import.meta.url), "utf8");
  const main = build.slice(build.indexOf("async function main()"));
  assert.equal(main.split("publishD1(").length - 1, 1, "one call to publishD1");
  assert.equal(main.split("publishKv(").length - 1, 1, "one call to publishKv");
  const run = main.indexOf("await runPublish(");
  const close = main.indexOf("\n  });", run);
  assert.ok(run > 0 && main.indexOf("publishD1(") > run && main.indexOf("publishD1(") < close, "publishD1 is inside the runPublish steps");
  assert.ok(main.indexOf("publishKv(") > run && main.indexOf("publishKv(") < close, "publishKv is inside the runPublish steps");
  assert.ok(existsSync(new URL("../etl/nfl/publish.mjs", import.meta.url)));
});

// ---------- the independent read-only check, run after an archive upload ----------
test("the archive check compares every object with the manifest and treats any readable unsigned request as public", async () => {
  const { verifyAgainstManifest, refusedAnonymously } = await import("../scripts/nfl-archive-verify.mjs");
  const a = Buffer.from("aaa"), b = Buffer.from("bbb");
  const store = new Map([["k/a", a], ["k/b", Buffer.from("changed")]]);
  const manifest = { sources: [{ dataset: "a", sha256: sha(a), archive_key: "k/a" }, { dataset: "b", sha256: sha(b), archive_key: "k/b" }, { dataset: "c", sha256: "x", archive_key: "k/c" }, { dataset: "d", sha256: "x", archive_key: null }] };
  const out = await verifyAgainstManifest(manifest, async (k) => store.get(k) ?? null);
  assert.deepEqual(out.map((r) => [r.dataset, r.ok]), [["a", true], ["b", false], ["c", false], ["d", false]]);
  assert.match(out[1].reason, /is not the recorded/);
  assert.equal(out[2].reason, "missing");
  assert.deepEqual((await verifyAgainstManifest({ sources: [] }, async () => null)).map((r) => r.ok), [false], "an empty manifest is not a verified archive");
  for (const s of [400, 401, 403]) assert.equal(refusedAnonymously(s), true);
  for (const s of [200, 206, 301, 302, 304, 404, 500]) assert.equal(refusedAnonymously(s), false, `${s} is not proof the bucket is private`);
});
