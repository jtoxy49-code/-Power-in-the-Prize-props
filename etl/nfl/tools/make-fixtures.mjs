// Builds the real 2026 nflverse test fixture from the builder's download
// cache. Run it only to refresh the fixture:
//
//   node etl/nfl/build.mjs --season 2026           (fills etl/nfl/.cache)
//   node etl/nfl/tools/make-fixtures.mjs
//
// The fixture is the source rows the builder parses (same columns), gzipped.
// Depth charts keep only each team's latest snapshot. Odds are not part of
// it: the tests generate a synthetic feed (test/fixtures/nfl/odds-synthetic.mjs).
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATASETS, fetchDataset, readDataset } from "../sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "..", "..", "test", "fixtures", "nfl");
const SEASON = 2026;
mkdirSync(OUT, { recursive: true });

const source = {};
const provenance = {};
for (const name of Object.keys(DATASETS)) {
  const snap = await fetchDataset(name, SEASON, { cacheDir: join(HERE, "..", ".cache"), offline: true });
  let rows = readDataset(snap, { filter: name === "schedule" ? (r) => Number(r.season) === SEASON : undefined });
  if (name === "depth_charts") {
    const latest = new Map();
    for (const r of rows) if (!latest.has(r.team) || r.dt > latest.get(r.team)) latest.set(r.team, r.dt);
    rows = rows.filter((r) => r.dt === latest.get(r.team));
  }
  source[name] = rows;
  provenance[name] = { url: snap.url, retrieved_at: snap.retrieved_at, source_last_modified: snap.last_modified, sha256: snap.sha256, rows: rows.length };
}
const write = (file, value) => { const gz = gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }); writeFileSync(join(OUT, file), gz); return gz.length; };
console.log(`source_${SEASON}.json.gz`, write(`source_${SEASON}.json.gz`, { season: SEASON, provenance, source }), "bytes");

