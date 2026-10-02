// INGESTION: a small CSV reader for the nflverse release files.
// It reads only the columns asked for, so a 370-column play-by-play file costs
// memory for the 45 columns the builder uses. Quoted fields, doubled quotes and
// line breaks inside quotes are handled.
import { gunzipSync } from "node:zlib";

/** Bytes of a .csv or .csv.gz file to text. */
export function decodeCsv(bytes, { gzip }) {
  return (gzip ? gunzipSync(bytes) : Buffer.from(bytes)).toString("utf8");
}

/**
 * @param {string} text
 * @param {object} opts
 * @param {string[]} [opts.columns]  columns to keep (default: all)
 * @param {string[]} [opts.required] columns that must exist, or this throws
 * @param {(row:object)=>boolean} [opts.filter] keep a row only if this returns true
 * @returns {{header:string[], rows:object[], total:number}}
 */
export function parseCsv(text, { columns, required = [], filter } = {}) {
  const rows = [];
  let header = null;
  let keep = null; // [index, name] pairs
  let total = 0;
  let fields = [];
  let i = 0;
  const n = text.length;
  const endRow = () => {
    if (!header) {
      header = fields.map((h) => h.replace(/^﻿/, ""));
      const missing = required.filter((c) => !header.includes(c));
      if (missing.length) throw new Error(`missing required column(s): ${missing.join(", ")}`);
      const want = columns || header;
      keep = want.filter((c) => header.includes(c)).map((c) => [header.indexOf(c), c]);
    } else if (fields.length > 1 || fields[0] !== "") {
      total++;
      const row = {};
      for (const [idx, name] of keep) row[name] = fields[idx] ?? "";
      if (!filter || filter(row)) rows.push(row);
    }
    fields = [];
  };
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) { // quoted field
      let value = "";
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) { value += text.slice(i); i = n; break; }
        value += text.slice(i, q);
        if (text.charCodeAt(q + 1) === 34) { value += '"'; i = q + 2; continue; }
        i = q + 1;
        break;
      }
      fields.push(value);
      const d = text.charCodeAt(i);
      if (d === 44) i++;
      else if (d === 13 || d === 10) { if (d === 13 && text.charCodeAt(i + 1) === 10) i++; i++; endRow(); }
      else if (i >= n) endRow();
      continue;
    }
    // unquoted field: runs to the next comma or line break
    let j = i;
    while (j < n) { const d = text.charCodeAt(j); if (d === 44 || d === 10 || d === 13) break; j++; }
    fields.push(text.slice(i, j));
    if (j >= n) { i = n; endRow(); break; }
    const d = text.charCodeAt(j);
    if (d === 44) {
      i = j + 1;
      if (i >= n) { fields.push(""); endRow(); }
    } else {
      i = d === 13 && text.charCodeAt(j + 1) === 10 ? j + 2 : j + 1;
      endRow();
    }
  }
  return { header: header || [], rows, total };
}

/** nflverse writes missing values as "" or "NA". Missing stays null; it is never 0. */
export function num(v) {
  if (v === undefined || v === null || v === "" || v === "NA") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
export const str = (v) => (v === undefined || v === null || v === "" || v === "NA" ? null : String(v));
export const flag = (v) => v === "1" || v === 1 || v === "TRUE" || v === "true" || v === true;
