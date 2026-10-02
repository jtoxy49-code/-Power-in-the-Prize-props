// Loads the real 2026 fixtures once per test process.
import { gunzipSync } from "node:zlib";
import { readFileSync, existsSync } from "node:fs";
import { deriveAll } from "../../../etl/nfl/build.mjs";
import { syntheticOddsRows } from "./odds-synthetic.mjs";

const read = (name) => JSON.parse(gunzipSync(readFileSync(new URL(name, import.meta.url))).toString("utf8"));

let sourceCache = null, derivedCache = new Map(), oddsCache = null, captureCache;

/** nflverse rows for 2026 as the builder parses them (Weeks 1-3 played). */
export function loadSource() {
  return (sourceCache ||= read("source_2026.json.gz"));
}

/** Everything the builder derives, for a given as-of week (default: the real current week). */
export function derive(asOfWeek) {
  const key = asOfWeek ?? "current";
  if (!derivedCache.has(key)) {
    const { season, source } = loadSource();
    derivedCache.set(key, deriveAll({ season, source, asOfWeek, capturedDate: "2026-10-02", buildId: "test-build", builtAt: "2026-10-02T03:35:00.000Z" }));
  }
  return derivedCache.get(key);
}

/**
 * Provider-shaped odds rows for the tests: the synthetic feed (real players and
 * games, made-up prices). Committed tests never depend on provider data.
 */
export function loadOddsRows() {
  return (oddsCache ||= syntheticOddsRows(derive().derived));
}

/**
 * The raw SharpAPI rows captured read-only on 2026-10-02, or null. That file is
 * the provider's data and is kept out of the repository; it exists only on a
 * machine where the probe was run.
 */
export function loadCaptureRows() {
  if (captureCache === undefined) captureCache = existsSync(new URL("odds_probe.json.gz", import.meta.url)) ? read("odds_probe.json.gz").rows : null;
  return captureCache;
}

/** A KV stand-in. */
export function memoryKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    store,
    writes: [],
    async get(key, type) { const v = store.get(key); return v == null ? null : type === "json" ? JSON.parse(v) : v; },
    async put(key, value) { this.writes.push(key); store.set(key, value); },
  };
}
