// D1 output: turns derived rows into SQL, one slice ("partition") of a table at
// a time, and skips every slice whose content has not changed since the last
// build. Re-running the same season and week therefore writes nothing, and a
// stat correction rewrites only the weeks it touched.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Column names per table, read from the migration so there is one schema. */
export function readSchema(migrationPath) {
  const sql = readFileSync(migrationPath, "utf8").replace(/--.*$/gm, "");
  const tables = {};
  for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\);/g)) {
    const cols = [];
    let depth = 0, part = "";
    for (const ch of m[2] + ",") {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        const name = part.trim().split(/\s+/)[0];
        if (name && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(name)) cols.push(name);
        part = "";
      } else part += ch;
    }
    tables[m[1]] = cols;
  }
  return tables;
}

// How each table is sliced. `where` deletes the slice before it is rewritten;
// a table without `where` is upserted (history tables keep earlier captures).
// `hashExclude` are columns that change every build without the content changing.
export const PARTITIONS = {
  nfl_teams: { part: () => "all", where: () => "1=1" },
  nfl_games: { part: (r) => `season=${r.season}`, where: (r) => `season = ${r.season}` },
  nfl_players: { part: (r) => `season=${r.latest_season}` },
  nfl_rosters: { part: (r) => `season=${r.season}/week=${r.week}`, where: (r) => `season = ${r.season} AND week = ${r.week}` },
  nfl_player_week: { part: (r) => `season=${r.season}/week=${r.week}`, where: (r) => `season = ${r.season} AND week = ${r.week}` },
  nfl_team_week: { part: (r) => `season=${r.season}/week=${r.week}`, where: (r) => `season = ${r.season} AND week = ${r.week}` },
  nfl_defense_game: { part: (r) => `season=${r.season}/week=${r.week}`, where: (r) => `season = ${r.season} AND week = ${r.week}` },
  nfl_defense_week: { part: (r) => `season=${r.season}/as_of_week=${r.as_of_week}`, where: (r) => `season = ${r.season} AND as_of_week = ${r.as_of_week}` },
  nfl_defense_position_week: { part: (r) => `season=${r.season}/as_of_week=${r.as_of_week}`, where: (r) => `season = ${r.season} AND as_of_week = ${r.as_of_week}` },
  nfl_player_usage_week: { part: (r) => `season=${r.season}/as_of_week=${r.as_of_week}`, where: (r) => `season = ${r.season} AND as_of_week = ${r.as_of_week}` },
  nfl_team_tendency_week: { part: (r) => `season=${r.season}/as_of_week=${r.as_of_week}`, where: (r) => `season = ${r.season} AND as_of_week = ${r.as_of_week}` },
  nfl_depth_charts: { part: (r) => `season=${r.season}/team=${r.team_id}`, where: (r) => `season = ${r.season} AND team_id = '${r.team_id}'` },
  // history: a new capture is added only when the report or the context changed
  nfl_injuries: { part: (r) => `season=${r.season}/week=${r.week}`, hashExclude: ["captured_date"] },
  nfl_game_environment: { part: (r) => `game=${r.game_id}`, hashExclude: ["captured_date"] },
};

const lit = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};

export function insertStatements(table, columns, rows, chunk = 40) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const values = rows.slice(i, i + chunk).map((r) => `(${columns.map((c) => lit(r[c])).join(",")})`).join(",\n");
    out.push(`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES\n${values};`);
  }
  return out;
}

/**
 * @param {object} schema  from readSchema()
 * @param {Record<string, object[]>} tables  table name -> rows
 * @param {Map<string,string>} existing  "table|part" -> content hash already in D1
 * @returns {{statements:string[], written:object[], skipped:number, rows:number}}
 */
export function planWrites(schema, tables, existing, { buildId, writtenAt }) {
  const statements = [];
  const written = [];
  let skipped = 0, rowsOut = 0;
  for (const [table, rows] of Object.entries(tables)) {
    const spec = PARTITIONS[table];
    const columns = schema[table];
    if (!spec || !columns) throw new Error(`no partition spec or schema for ${table}`);
    const extra = rows.length ? Object.keys(rows[0]).filter((k) => !columns.includes(k)) : [];
    const missing = rows.length ? columns.filter((c) => !(c in rows[0])) : [];
    if (missing.length) throw new Error(`${table}: rows lack column(s) ${missing.join(", ")}`);
    if (extra.length) throw new Error(`${table}: rows carry column(s) the schema lacks: ${extra.join(", ")}`);
    const parts = new Map();
    for (const r of rows) { const k = spec.part(r); if (!parts.has(k)) parts.set(k, []); parts.get(k).push(r); }
    for (const [part, list] of parts) {
      const hashCols = columns.filter((c) => !(spec.hashExclude || []).includes(c));
      const hash = createHash("sha256").update(JSON.stringify(list.map((r) => hashCols.map((c) => r[c] ?? null)))).digest("hex").slice(0, 32);
      if (existing.get(`${table}|${part}`) === hash) { skipped++; continue; }
      if (spec.where) statements.push(`DELETE FROM ${table} WHERE ${spec.where(list[0])};`);
      statements.push(...insertStatements(table, columns, list));
      statements.push(`INSERT OR REPLACE INTO nfl_partitions (table_name, part, content_hash, row_count, build_id, written_at) VALUES (${[table, part, hash, list.length, buildId, writtenAt].map(lit).join(",")});`);
      written.push({ table, part, rows: list.length, hash });
      rowsOut += list.length;
    }
  }
  return { statements, written, skipped, rows: rowsOut };
}
