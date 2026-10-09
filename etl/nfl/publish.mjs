// PUBLISH: the only code that writes to Cloudflare. It shells out to wrangler,
// which authenticates with CLOUDFLARE_API_TOKEN in GitHub Actions and with the
// local wrangler login on a developer machine. No credential is read, printed
// or stored here.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { POINTER_KEY, BUILD_PREFIX, buildKey } from "../../src/nfl/snapshot.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const D1_NAME = "pwr-props-nfl";
export const R2_BUCKET = "pwr-props-archive";
// The binding has a production id and a preview id; "--preview false" names production explicitly.
const KV_TARGET = ["--binding=PROPS_DATA", "--preview", "false"];

function wrangler(args, { capture = false } = {}) {
  // The project's own wrangler, run with this Node directly: no shell, so no
  // argument is ever re-parsed by one.
  const bin = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  return execFileSync(process.execPath, [bin, ...args], { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", maxBuffer: 64 * 1024 * 1024 });
}

/** The line of a failed wrangler call that says why (its ERROR line), or the error's own first line. */
export function failureLine(err) {
  const lines = `${err.stderr || ""}\n${err.stdout || ""}`.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  return (lines.find((l) => /ERROR/.test(l)) || String(err.message).split(/\r?\n/)[0]).trim();
}

/** "table|part" -> hash for every slice already in D1 (empty if the table is new). */
export function readExistingPartitions() {
  try {
    const out = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", "SELECT table_name, part, content_hash FROM nfl_partitions"], { capture: true });
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    return new Map((parsed[0]?.results || []).map((r) => [`${r.table_name}|${r.part}`, r.content_hash]));
  } catch (err) {
    console.log(`  could not read existing table slices (${String(err.message).split("\n")[0]}); writing all`);
    return new Map();
  }
}

export function publishD1(sqlFile) {
  console.log("  publishing to D1 ...");
  wrangler(["d1", "execute", D1_NAME, "--remote", "--yes", `--file=${sqlFile}`]);
}

/**
 * The KV operations a publish needs, through wrangler. production is the
 * default; { local: true } is wrangler's on-disk store, for rehearsing the
 * commands without touching the account.
 */
export function wranglerKv({ local = false, dir = tmpdir() } = {}) {
  const target = local ? [...KV_TARGET, "--local"] : KV_TARGET;
  const file = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };
  return {
    async list(prefix) {
      const out = wrangler(["kv", "key", "list", ...target, "--prefix", prefix], { capture: true });
      return JSON.parse(out.slice(out.indexOf("["))).map((k) => k.name);
    },
    async get(key) { return wrangler(["kv", "key", "get", key, ...target, "--text"], { capture: true }); },
    async bulkPut(entries) { wrangler(["kv", "bulk", "put", file("nfl-kv-build.json", JSON.stringify(entries)), ...target], { capture: true }); },
    async put(key, value) { wrangler(["kv", "key", "put", key, "--path", file("nfl-kv-pointer.json", value), ...target], { capture: true }); },
    async bulkDelete(keys) { wrangler(["kv", "bulk", "delete", file("nfl-kv-delete.json", JSON.stringify(keys)), ...target, "--force"], { capture: true }); },
  };
}

// How long a finished build sits in KV before readers are pointed at it. KV
// documents up to 60 seconds for a write to be visible everywhere, and gives
// no hard bound. The wait makes it unlikely that an edge sees the pointer
// before a payload; it does not prove it. What covers the rest is the reader:
// a payload it cannot read sends the whole request to the previous build.
export const KV_SETTLE_MS = 75_000;

// How long a build's keys stay in KV after it stops being the current build.
// KV edge caches are measured in seconds to minutes; this is two days. A build
// the pointer does not list (a failed publish, or one overwritten by a
// concurrent publisher) is kept until it is this old, counted from the time in
// its build id, so one publisher never deletes what another is still writing.
export const BUILD_RETENTION_MS = 48 * 3600_000;

/** The time a build id carries ("2026-20261002T082000Z"), in ms, or NaN. */
export function buildTime(buildId) {
  const m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(buildId));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
}

/**
 * Publishes one build to KV so that readers only ever see a whole build.
 *
 *   1. read the live pointer (nfl:current)
 *   2. write this build under its own keys, nfl:build:{build_id}:...
 *      (new keys: nothing a reader is using is overwritten)
 *   3. check every key is there and the build's stamp reads back
 *   4. wait for KV to settle
 *   5. read the pointer again (another publisher may have moved it), then
 *      write it: current = this build, previous = the one that was live,
 *      retained = every superseded build still inside the retention time
 *   6. delete only builds superseded longer ago than BUILD_RETENTION_MS, and
 *      unlisted builds older than that
 *
 * A failure in steps 1 to 4 leaves the pointer alone: readers stay on the
 * build they had, whole, and the half-written keys are never read. A failure
 * in step 5 leaves either pointer, and both builds are complete. A failure in
 * step 6 is logged and costs only storage.
 *
 * What a reader is guaranteed: the build named `current` by any pointer value
 * that was live in the last BUILD_RETENTION_MS is still complete in KV, and so
 * is the build before the live one. Beyond that the answer is 503, never a
 * mixture. This is one pointer over immutable keys, not a transaction: see
 * src/nfl/snapshot.js for what readers can still observe.
 *
 * @param {{key:string,value:string}[]} entries  payloads under their plain nfl: names
 */
export async function publishKv(entries, { buildId, season, asOfWeek, kv = wranglerKv(), settleMs = KV_SETTLE_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString(), log = console.log } = {}) {
  const stray = entries.filter((e) => !e.key.startsWith("nfl:"));
  if (stray.length) throw new Error(`refusing to publish non-NFL KV keys: ${stray.map((e) => e.key).join(", ")}`);
  const reserved = entries.filter((e) => e.key === POINTER_KEY || e.key.startsWith(BUILD_PREFIX) || e.key.startsWith("nfl:odds:"));
  if (reserved.length) throw new Error(`refusing to publish reserved KV keys: ${reserved.map((e) => e.key).join(", ")}`);
  if (!/^[A-Za-z0-9-]+$/.test(String(buildId))) throw new Error(`build id "${buildId}" cannot be used in a KV key`);
  if (!entries.some((e) => e.key === "nfl:meta")) throw new Error("the build has no nfl:meta payload");

  const readPointer = async () => {
    if (!(await kv.list(POINTER_KEY)).includes(POINTER_KEY)) return null;
    let p = null;
    try { p = JSON.parse(await kv.get(POINTER_KEY)); } catch { p = null; }
    if (!p?.current?.build_id) throw new Error("the live pointer (nfl:current) exists but cannot be read; nothing was changed");
    return p;
  };

  // 1. what is live
  const atStart = await readPointer();
  if (atStart?.current.build_id === buildId) throw new Error(`build ${buildId} is already the live build`);

  // 2. this build, under its own keys
  log(`  KV: writing ${entries.length} payloads under ${BUILD_PREFIX}${buildId}: ...`);
  await kv.bulkPut(entries.map((e) => ({ key: buildKey(buildId, e.key), value: e.value })));

  // 3. is it all there
  const present = new Set(await kv.list(`${BUILD_PREFIX}${buildId}:`));
  const absent = entries.filter((e) => !present.has(buildKey(buildId, e.key)));
  if (absent.length) throw new Error(`${absent.length} of ${entries.length} keys of build ${buildId} are not in KV`);
  let stamp = null;
  try { stamp = JSON.parse(await kv.get(buildKey(buildId, "nfl:meta"))); } catch { stamp = null; }
  if (stamp?.build_id !== buildId) throw new Error(`the stamp of build ${buildId} does not read back`);

  // 4. settle
  if (settleMs > 0) { log(`  KV: waiting ${Math.round(settleMs / 1000)}s before pointing readers at the build ...`); await sleep(settleMs); }

  // 5. the pointer, built on what is live NOW (a concurrent publisher may have moved it during the wait)
  const live = await readPointer();
  if (live?.current.build_id === buildId) throw new Error(`build ${buildId} is already the live build`);
  if (live && atStart && live.current.build_id !== atStart.current.build_id) log(`  KV: another publish moved the pointer to ${live.current.build_id} meanwhile; this build goes on top of it`);
  const nowIso = now(), nowMs = Date.parse(nowIso);
  // every superseded build still stored, newest first; the first is the reader's fallback and is always kept
  const superseded = [];
  if (live) {
    superseded.push({ ...live.current, superseded_at: nowIso });
    const older = live.retained ? live.retained.filter((b) => b.build_id !== live.current.build_id) : live.previous ? [{ ...live.previous, superseded_at: live.previous.superseded_at ?? live.current.published_at ?? nowIso }] : [];
    for (const b of older) if (b?.build_id && b.build_id !== buildId && !superseded.some((x) => x.build_id === b.build_id)) superseded.push(b);
  }
  const expired = superseded.filter((b, i) => i > 0 && nowMs - Date.parse(b.superseded_at) > BUILD_RETENTION_MS);
  const retained = superseded.filter((b) => !expired.includes(b));
  const pointer = { schema: 2, current: { build_id: buildId, season, as_of_week: asOfWeek, published_at: nowIso, names: entries.map((e) => e.key.slice(4)) }, previous: retained[0] ?? null, retained };
  await kv.put(POINTER_KEY, JSON.stringify(pointer));
  let back = null;
  try { back = JSON.parse(await kv.get(POINTER_KEY)); } catch { back = null; }
  if (back?.current?.build_id !== buildId) throw new Error("the pointer did not read back as this build");
  log(`  KV: live build is now ${buildId}${pointer.previous ? ` (previous: ${pointer.previous.build_id}; ${retained.length} superseded build(s) retained)` : ""}`);

  // 6. only what is old enough that no reader can still be on it
  let removed = 0;
  try {
    const listed = new Set([buildId, ...retained.map((b) => b.build_id)]);
    const gone = new Set(expired.map((b) => b.build_id));
    const keys = (await kv.list(BUILD_PREFIX)).filter((k) => k.startsWith(BUILD_PREFIX));
    const idOf = (k) => k.slice(BUILD_PREFIX.length).split(":")[0];
    const unlisted = [...new Set(keys.map(idOf))].filter((id) => !listed.has(id) && !gone.has(id));
    // an unlisted build (failed, or dropped by a concurrent publisher) goes only when its own id says it is old; an id with no time in it is left alone
    for (const id of unlisted) if (nowMs - buildTime(id) > BUILD_RETENTION_MS) gone.add(id);
    const young = unlisted.filter((id) => !gone.has(id));
    if (young.length) log(`  KV: ${young.length} unlisted build(s) kept until they are ${BUILD_RETENTION_MS / 3600_000} hours old: ${young.join(", ")}`);
    const old = keys.filter((k) => gone.has(idOf(k)));
    if (old.length) { await kv.bulkDelete(old); removed = old.length; log(`  KV: removed ${removed} keys of ${gone.size} build(s) past retention`); }
  } catch (err) {
    log(`  KV: older builds were not removed (${failureLine(err)}); the next publish will try again`);
  }
  return { pointer, removed };
}

/** The newest archived copy of each source file: "dataset|season" -> { sha256, archive_key }. */
export function readArchivedSnapshots() {
  try {
    const out = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", "SELECT dataset, season, sha256, archive_key FROM nfl_data_snapshots WHERE archive_key IS NOT NULL ORDER BY build_id"], { capture: true });
    const parsed = JSON.parse(out.slice(out.indexOf("[")));
    return new Map((parsed[0]?.results || []).map((r) => [`${r.dataset}|${r.season}`, { sha256: r.sha256, archive_key: r.archive_key }]));
  } catch { return new Map(); }
}

/** The installed wrangler's major version, read when an R2 client is made. */
function wranglerMajor() {
  return Number(JSON.parse(readFileSync(join(ROOT, "node_modules", "wrangler", "package.json"), "utf8")).version.split(".")[0]);
}

/**
 * The R2 operations the archive needs, through wrangler, against the account.
 * wrangler 3 acts on the account by default and has no --remote flag; from
 * wrangler 4 the same commands act on LOCAL storage unless --remote is given,
 * which would make an upload and its read-back both "succeed" without
 * anything reaching R2. So the flag is added whenever the major version is 4
 * or later.
 */
export function wranglerR2() {
  const remote = wranglerMajor() >= 4 ? ["--remote"] : [];
  return {
    async put(key, path) { wrangler(["r2", "object", "put", `${R2_BUCKET}/${key}`, `--file=${path}`, "--content-type=application/octet-stream", ...remote], { capture: true }); },
    async get(key, dest) { wrangler(["r2", "object", "get", `${R2_BUCKET}/${key}`, `--file=${dest}`, ...remote], { capture: true }); },
  };
}

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Copies the source files a build consumed to the private R2 bucket, exactly
 * as downloaded, and proves each one is there: every object the build will
 * point at is read back from R2 and its SHA-256 compared with the one recorded
 * when the file was downloaded. Nothing is taken on trust.
 *
 *   - A file identical to the newest archived copy (same SHA-256 in D1) is not
 *     uploaded again, but that copy is still read back and checked. If it is
 *     missing or does not match, the file is uploaded again under this build.
 *   - After the sources, the build's manifest (source URL, retrieval time,
 *     upstream last-modified and ETag, SHA-256, bytes, rows, archive key) is
 *     uploaded and checked the same way.
 *
 * Returns { keys, uploaded, reused, verified, failures, manifestKey }. Any
 * entry in `failures` means the archive is not complete, and the caller must
 * not publish the data (see runPublish in build.mjs).
 *
 * @param {{dataset,season,sha256,key,path}[]} files
 * @param {Map} archived  "dataset|season" -> { sha256, archive_key } from D1
 * @param {object} o  { r2: { put(key, path), get(key, dest) }, manifestKey, manifest(keys) -> object, tmpDir, log }
 */
export async function archiveSources(files, archived, { r2, manifestKey, manifest, tmpDir, log = console.log }) {
  mkdirSync(tmpDir, { recursive: true });
  const keys = new Map(), failures = [];
  let uploaded = 0, reused = 0, verified = 0, n = 0;
  const verify = async (key, expected) => {
    const dest = join(tmpDir, `readback-${++n}`);
    try {
      await r2.get(key, dest);
      if (!existsSync(dest)) throw new Error(`nothing came back for ${key}`);
      const got = sha256File(dest);
      if (got !== expected) throw new Error(`${key} read back with SHA-256 ${got.slice(0, 12)}..., expected ${expected.slice(0, 12)}...`);
      verified++;
    } finally { rmSync(dest, { force: true }); }
  };
  const why = (err) => failureLine(err);

  for (const f of files) {
    const prior = archived.get(`${f.dataset}|${f.season}`);
    if (prior?.archive_key && prior.sha256 === f.sha256) {
      try { await verify(prior.archive_key, f.sha256); keys.set(f.dataset, prior.archive_key); reused++; continue; }
      catch (err) { log(`  R2: the archived copy of ${f.dataset} (${prior.archive_key}) did not verify (${why(err)}); uploading it again`); }
    }
    try {
      if (sha256File(f.path) !== f.sha256) throw new Error(`the local file no longer matches the SHA-256 recorded at download`);
      await r2.put(f.key, f.path);
      await verify(f.key, f.sha256);
      keys.set(f.dataset, f.key); uploaded++;
    } catch (err) {
      keys.set(f.dataset, null);
      failures.push({ dataset: f.dataset, reason: why(err) });
      log(`  R2: ${f.dataset} FAILED: ${why(err)}`);
    }
  }

  // the manifest goes last, so it names the archive key of every source
  let manifestDone = null;
  if (!failures.length) {
    const path = join(tmpDir, "manifest.json");
    try {
      writeFileSync(path, JSON.stringify(manifest(keys), null, 2));
      const expected = sha256File(path);
      await r2.put(manifestKey, path);
      await verify(manifestKey, expected);
      manifestDone = manifestKey;
    } catch (err) {
      failures.push({ dataset: "manifest", reason: why(err) });
      log(`  R2: manifest FAILED: ${why(err)}`);
    }
  }
  log(`  R2: ${uploaded} uploaded, ${reused} unchanged and reused, ${verified} objects read back and checked, ${failures.length} failed`);
  return { keys, uploaded, reused, verified, failures, manifestKey: manifestDone };
}
