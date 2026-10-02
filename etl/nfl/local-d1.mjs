// A local stand-in for the Worker's D1 binding, backed by a real SQLite engine
// (node:sqlite) with the project's migrations applied. The tests and the
// offline inspection script use it, so the SQL the Worker sends to D1 is
// executed, not imitated.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** An in-memory database with every migration applied, exposing D1's prepare().bind().run()/first()/all(). */
export async function localD1({ only } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && (!only || only.includes(f))).sort()) db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { success: true, results: db.prepare(sql).all(...args) }; },
  });
  return { prepare: (sql) => statement(sql), sqlite: db };
}
