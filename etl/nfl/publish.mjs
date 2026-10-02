// PUBLISH: the only code that writes to Cloudflare. It shells out to wrangler,
// which authenticates with CLOUDFLARE_API_TOKEN in GitHub Actions and with the
// local wrangler login on a developer machine. No credential is read, printed
// or stored here.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const D1_NAME = "pwr-props-nfl";

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

export function publishKv(jsonFile) {
  console.log("  publishing payloads to KV ...");
  wrangler(["kv", "bulk", "put", jsonFile, "--binding=PROPS_DATA"]);
}
