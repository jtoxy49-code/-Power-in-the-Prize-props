// PUBLISH: the only code that writes to Cloudflare. It shells out to wrangler,
// which authenticates with CLOUDFLARE_API_TOKEN in GitHub Actions and with the
// local wrangler login on a developer machine. No credential is read, printed
// or stored here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Payloads first, the build stamp last. Each call is one bulk request, so the
 * payloads land together; nfl:meta (which names the build) moves only after
 * they have, and a failure before that leaves the previous stamp in place.
 * Every key is in the nfl: namespace; an entry outside it stops the publish.
 */
export function publishKv(jsonFile) {
  const all = JSON.parse(readFileSync(jsonFile, "utf8"));
  const stray = all.filter((e) => !e.key.startsWith("nfl:"));
  if (stray.length) throw new Error(`refusing to publish non-NFL KV keys: ${stray.map((e) => e.key).join(", ")}`);
  const meta = all.filter((e) => e.key === "nfl:meta"), payloads = all.filter((e) => e.key !== "nfl:meta");
  const dir = dirname(jsonFile);
  writeFileSync(join(dir, "kv-payloads.json"), JSON.stringify(payloads));
  writeFileSync(join(dir, "kv-meta.json"), JSON.stringify(meta));
  console.log(`  publishing ${payloads.length} payloads to KV ...`);
  wrangler(["kv", "bulk", "put", join(dir, "kv-payloads.json"), ...KV_TARGET]);
  console.log("  publishing the build stamp (nfl:meta) ...");
  wrangler(["kv", "bulk", "put", join(dir, "kv-meta.json"), ...KV_TARGET]);
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
