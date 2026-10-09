// Read-only check of the NFL source archive in R2, independent of the build
// that wrote it.
//
//   node scripts/nfl-archive-verify.mjs <build id>
//
// It reads the build's manifest from the bucket, downloads every object the
// manifest names, and compares each one's SHA-256 with the manifest's (which is
// the checksum recorded when the file was downloaded from nflverse). Then it
// checks that nobody can read the bucket without credentials: the public
// r2.dev URL is disabled, no custom domain is attached, and an unsigned GET of
// an object through the S3 endpoint is refused.
//
// It only reads. It never uploads, deletes or changes a setting. Exit 0 when
// every check passes, 1 otherwise.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const BUCKET = "pwr-props-archive";

/**
 * Compares every object a manifest names with its recorded SHA-256.
 * @param {object} manifest  { sources: [{ dataset, sha256, archive_key }] }
 * @param {(key: string) => Promise<Buffer|null>} fetchObject  the object's bytes, or null if absent
 */
export async function verifyAgainstManifest(manifest, fetchObject) {
  const results = [];
  for (const s of manifest?.sources || []) {
    if (!s.archive_key) { results.push({ dataset: s.dataset, ok: false, reason: "no archive key in the manifest" }); continue; }
    let bytes = null, reason = null;
    try { bytes = await fetchObject(s.archive_key); } catch (err) { reason = String(err.message).split(/\r?\n/)[0]; }
    if (!bytes) { results.push({ dataset: s.dataset, key: s.archive_key, ok: false, reason: reason || "missing" }); continue; }
    const got = createHash("sha256").update(bytes).digest("hex");
    results.push({ dataset: s.dataset, key: s.archive_key, bytes: bytes.length, ok: got === s.sha256, reason: got === s.sha256 ? null : `SHA-256 ${got.slice(0, 12)}... is not the recorded ${String(s.sha256).slice(0, 12)}...` });
  }
  if (!results.length) results.push({ dataset: "manifest", ok: false, reason: "the manifest lists no sources" });
  return results;
}

/** An unsigned request must be refused: 400, 401 or 403 (anything 2xx or 3xx is public access). */
export const refusedAnonymously = (status) => [400, 401, 403].includes(status);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const buildId = process.argv[2];
  if (!/^\d{4}-\d{8}T\d{6}Z$/.test(buildId || "")) { console.error("usage: node scripts/nfl-archive-verify.mjs <build id, e.g. 2026-20261009T082000Z>"); process.exit(1); }
  const season = buildId.slice(0, 4);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const major = Number(JSON.parse(readFileSync(join(root, "node_modules", "wrangler", "package.json"), "utf8")).version.split(".")[0]);
  const remote = major >= 4 ? ["--remote"] : [];
  const w = (args) => execFileSync(process.execPath, [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  const dir = mkdtempSync(join(tmpdir(), "nfl-archive-verify-"));
  const fetchObject = async (key) => {
    const dest = join(dir, `obj-${Math.random().toString(36).slice(2)}`);
    w(["r2", "object", "get", `${BUCKET}/${key}`, `--file=${dest}`, ...remote]);
    if (!existsSync(dest)) return null;
    const bytes = readFileSync(dest); rmSync(dest, { force: true }); return bytes;
  };
  let failed = 0;
  try {
    const manifestKey = `nflverse/${season}/${buildId}/manifest.json`;
    const manifest = JSON.parse((await fetchObject(manifestKey)).toString("utf8"));
    console.log(`manifest ${manifestKey}: build ${manifest.build_id}, ${manifest.sources?.length ?? 0} sources`);
    for (const r of await verifyAgainstManifest(manifest, fetchObject)) {
      if (!r.ok) failed++;
      console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.dataset.padEnd(18)} ${r.key ?? ""}${r.bytes ? ` ${r.bytes} bytes` : ""}${r.reason ? ` - ${r.reason}` : ""}`);
    }
    // nobody gets in without credentials
    const devUrl = w(["r2", "bucket", "dev-url", "get", BUCKET]);
    const devDisabled = /disabled/i.test(devUrl) && !/is enabled/i.test(devUrl);
    console.log(`  ${devDisabled ? "ok  " : "FAIL"} public r2.dev URL disabled`); if (!devDisabled) failed++;
    const domains = w(["r2", "bucket", "domain", "list", BUCKET]);
    const noDomain = !/\bdomain:\s*\S+\.\S+/i.test(domains) && !/enabled:\s*true/i.test(domains);
    console.log(`  ${noDomain ? "ok  " : "FAIL"} no custom domain attached`); if (!noDomain) failed++;
    const account = (w(["whoami"]).match(/[0-9a-f]{32}/) || [])[0];
    const key = manifest.sources?.find((s) => s.archive_key)?.archive_key;
    if (account && key) {
      const res = await fetch(`https://${account}.r2.cloudflarestorage.com/${BUCKET}/${key}`, { redirect: "manual" });
      const refused = refusedAnonymously(res.status);
      console.log(`  ${refused ? "ok  " : "FAIL"} an unsigned GET of an archived object is refused (HTTP ${res.status})`); if (!refused) failed++;
    } else { console.log("  FAIL could not test anonymous access (no account id or no object)"); failed++; }
  } catch (err) {
    console.log(`FAIL ${String(err.stderr || err.message).split(/\r?\n/).find((l) => /ERROR|not|fail/i.test(l)) || err.message}`);
    failed++;
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(failed ? `ARCHIVE NOT VERIFIED: ${failed} check(s) failed` : "ARCHIVE VERIFIED");
  process.exit(failed ? 1 : 0);
}
