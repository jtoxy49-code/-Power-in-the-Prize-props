// PUBLISH: the only code that writes to Cloudflare. It shells out to wrangler,
// which authenticates with CLOUDFLARE_API_TOKEN in GitHub Actions and with the
// local wrangler login on a developer machine. No credential is read, printed
// or stored here.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
// documents up to 60 seconds for a write to be visible everywhere; the pointer
// moves after that, so a payload is readable wherever the pointer is.
export const KV_SETTLE_MS = 75_000;

/**
 * Publishes one build to KV so that readers only ever see a whole build.
 *
 *   1. read the live pointer (nfl:current)
 *   2. write this build under its own keys, nfl:build:{build_id}:...
 *      (new keys: nothing a reader is using is overwritten)
 *   3. check every key is there and the build's stamp reads back
 *   4. wait for KV to settle
 *   5. move the pointer: current = this build, previous = the one that was live
 *   6. delete builds that are neither
 *
 * A failure in steps 1 to 4 leaves the pointer alone: readers stay on the
 * build they had, whole, and the half-written keys are never read (the next
 * publish removes them). A failure in step 5 leaves either pointer, and both
 * builds are complete. A failure in step 6 is logged and costs only storage.
 *
 * This is one pointer over immutable keys, not a transaction: see
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

  // 1. what is live
  let live = null;
  if ((await kv.list(POINTER_KEY)).includes(POINTER_KEY)) {
    try { live = JSON.parse(await kv.get(POINTER_KEY)); } catch { live = null; }
    if (!live?.current?.build_id) throw new Error("the live pointer (nfl:current) exists but cannot be read; nothing was changed");
    if (live.current.build_id === buildId) throw new Error(`build ${buildId} is already the live build`);
  }

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

  // 5. the pointer
  const pointer = { schema: 1, current: { build_id: buildId, season, as_of_week: asOfWeek, published_at: now(), names: entries.map((e) => e.key.slice(4)) }, previous: live?.current ?? null };
  await kv.put(POINTER_KEY, JSON.stringify(pointer));
  let back = null;
  try { back = JSON.parse(await kv.get(POINTER_KEY)); } catch { back = null; }
  if (back?.current?.build_id !== buildId) throw new Error("the pointer did not read back as this build");
  log(`  KV: live build is now ${buildId}${pointer.previous ? ` (previous: ${pointer.previous.build_id})` : ""}`);

  // 6. builds nobody points at
  let removed = 0;
  try {
    const keep = new Set([buildId, pointer.previous?.build_id].filter(Boolean));
    const old = (await kv.list(BUILD_PREFIX)).filter((k) => k.startsWith(BUILD_PREFIX) && !keep.has(k.slice(BUILD_PREFIX.length).split(":")[0]));
    if (old.length) { await kv.bulkDelete(old); removed = old.length; log(`  KV: removed ${removed} keys of older builds`); }
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

/**
 * Copies the source files a build consumed to the private R2 bucket, exactly
 * as downloaded. A file whose SHA-256 matches the newest archived copy is not
 * uploaded again; the build points at the existing object. Returns the object
 * key per dataset, or null where the upload failed (the caller reports it and
 * the build is marked failed, without holding back the data publish).
 */
export function publishR2(files, archived) {
  const keys = new Map();
  let uploaded = 0, reused = 0, failed = 0;
  for (const f of files) {
    const prior = archived.get(`${f.dataset}|${f.season}`);
    if (prior && prior.sha256 === f.sha256) { keys.set(f.dataset, prior.archive_key); reused++; continue; }
    try {
      wrangler(["r2", "object", "put", `${R2_BUCKET}/${f.key}`, `--file=${f.path}`, "--content-type=application/octet-stream"], { capture: true });
      keys.set(f.dataset, f.key); uploaded++;
    } catch (err) {
      keys.set(f.dataset, null); failed++;
      const why = String(err.stderr || err.stdout || err.message).split(/\r?\n/).find((l) => /ERROR|enable|denied|fail/i.test(l)) || "see wrangler output";
      console.log(`  R2 upload FAILED for ${f.dataset}: ${why.trim()}`);
    }
  }
  console.log(`  R2: ${uploaded} uploaded, ${reused} unchanged and reused, ${failed} failed`);
  return { keys, failed };
}
