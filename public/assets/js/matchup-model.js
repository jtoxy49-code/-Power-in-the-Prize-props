// LINEUP MATCHUPS model. Pure functions, no DOM: given a pitcher's arsenal,
// the opposing hitters, each hitter's season rows by pitch type and the MLB
// benchmark per pitch type, build the matrix, the weighted "vs his mix"
// figures, the lineup row, the findings and the rankings. Every threshold
// that decides what is shown lives here, so the page and its method note
// describe the same rules.

// A pitch earns a matrix column when he throws it at least this often.
export const MIN_USAGE = 3;
// A hitter's cell counts (tinted, ranked, weighted) from this sample up.
// Smaller samples are shown muted and left out of every derived figure.
export const MIN_PA = 20;
export const MIN_PITCHES = 50;
// A weighted figure needs this share of the pitcher's plate appearances covered.
export const MIN_COVERAGE = 0.75;
// Findings about "his main pitches" use pitches thrown at least this often.
export const MAIN_USAGE = 10;
// A lineup whiff gap smaller than this many points is "about MLB rates".
export const WHIFF_GAP = 2;

export const METRICS = {
  xba: {
    key: "est_ba", label: "xBA", name: "expected batting average", sample: "pa", min: MIN_PA,
    hitterBetter: "high", bands: [0.02, 0.05], weighted: true, digits: 3,
  },
  whiff: {
    key: "whiff_pct", label: "Whiff%", name: "whiff rate per swing", sample: "pitches", min: MIN_PITCHES,
    hitterBetter: "low", bands: [3, 8], weighted: false, digits: 1,
  },
  k: {
    key: "k_pct", label: "K%", name: "strikeout rate", sample: "pa", min: MIN_PA,
    hitterBetter: "low", bands: [3, 8], weighted: true, digits: 1,
  },
};

const has = (v) => v != null && Number.isFinite(v);

/** The pitches that get a column, most used first, and the ones left out. */
export function pitchColumns(arsenal) {
  const all = (arsenal || []).filter((p) => p.pitch_type).slice().sort((a, b) => (b.usage_pct ?? -1) - (a.usage_pct ?? -1));
  const totalPa = all.reduce((s, p) => s + (p.pa || 0), 0);
  const cols = all.filter((p) => has(p.usage_pct) && p.usage_pct >= MIN_USAGE).map((p, i) => ({
    type: p.pitch_type, name: p.pitch_name || p.pitch_type, usage: p.usage_pct, pa: p.pa || 0,
    whiff: has(p.whiff_pct) ? p.whiff_pct : null, k: has(p.k_pct) ? p.k_pct : null, xba: has(p.est_ba) ? p.est_ba : null,
    // Share of all his plate appearances that ended on this pitch: the weight.
    share: totalPa > 0 ? (p.pa || 0) / totalPa : null,
    rank: i,
  }));
  const minor = all.filter((p) => !cols.some((c) => c.type === p.pitch_type)).map((p) => ({ type: p.pitch_type, name: p.pitch_name || p.pitch_type, usage: has(p.usage_pct) ? p.usage_pct : null }));
  return { cols, minor, totalPa };
}

/** One hitter's row against one pitch type, or null when he has none. */
export function cellOf(rows, type) {
  return (rows || []).find((r) => r.pitch_type === type) || null;
}

const sampleOf = (row, metric) => (row ? (METRICS[metric].sample === "pa" ? row.pa || 0 : row.pitches || 0) : 0);
export const qualifies = (row, metric) => !!row && has(row[METRICS[metric].key]) && sampleOf(row, metric) >= METRICS[metric].min;

/**
 * Where a qualifying value sits against the MLB benchmark for that pitch, from
 * the hitter's side: "hitter" means better than MLB hitters, "pitcher" worse.
 * Strength is a display band (even / edge / strong), not a statistical test.
 */
export function edgeOf(value, league, metric) {
  if (!has(value) || !has(league)) return null;
  const m = METRICS[metric];
  const d = m.hitterBetter === "high" ? value - league : league - value;
  const a = Math.abs(d);
  const strength = a < m.bands[0] ? "even" : a < m.bands[1] ? "edge" : "strong";
  return { side: strength === "even" ? "even" : d > 0 ? "hitter" : "pitcher", strength, delta: d };
}

/**
 * The weighted "vs his mix" figure for one hitter, for xBA or K%:
 *   sum(w_i * v_i) / sum(w_i)
 * over the matrix pitches where the hitter has at least MIN_PA plate
 * appearances and a value, with w_i = the share of the pitcher's plate
 * appearances that ended on pitch i. Coverage = sum(w_i) of the pitches used.
 * No figure below MIN_COVERAGE. Whiff% is not weighted: it is per swing and
 * swings by pitch type are not in the data.
 */
export function weighted(rowsOrCells, cols, metric) {
  const m = METRICS[metric];
  if (!m.weighted) return null;
  let num = 0, den = 0;
  cols.forEach((c) => {
    if (c.share == null) return;
    const row = Array.isArray(rowsOrCells) ? cellOf(rowsOrCells, c.type) : rowsOrCells[c.type];
    if (!qualifies(row, metric)) return;
    num += c.share * row[m.key];
    den += c.share;
  });
  if (den <= 0) return { value: null, coverage: 0 };
  return { value: num / den, coverage: den, ok: den >= MIN_COVERAGE - 1e-9 };
}

/** The same weights applied to the MLB benchmarks: an MLB-average hitter vs his mix. */
export function leagueWeighted(cols, league, metric) {
  const m = METRICS[metric];
  if (!m.weighted) return null;
  let num = 0, den = 0;
  cols.forEach((c) => {
    const v = league?.[c.type]?.[m.key];
    if (c.share == null || !has(v)) return;
    num += c.share * v; den += c.share;
  });
  return den > 0 ? num / den : null;
}

/**
 * The lineup row: the hitters' rows against each pitch combined into one,
 * weighted by PA (by pitches seen for Whiff%). Every hitter with a value counts,
 * including small samples, because the combined sample is what is shown.
 */
export function lineupRow(hitters, cols) {
  const out = {};
  cols.forEach((c) => {
    const acc = { pa: 0, pitches: 0 };
    Object.entries(METRICS).forEach(([id, m]) => {
      let num = 0, den = 0;
      hitters.forEach((h) => {
        const r = h.cells[c.type];
        if (!r || !has(r[m.key])) return;
        const w = m.sample === "pa" ? r.pa || 0 : r.pitches || 0;
        num += r[m.key] * w; den += w;
      });
      acc[m.key] = den > 0 ? num / den : null;
    });
    hitters.forEach((h) => { const r = h.cells[c.type]; if (r) { acc.pa += r.pa || 0; acc.pitches += r.pitches || 0; } });
    out[c.type] = acc;
  });
  return out;
}

/** Build everything the page draws. */
export function buildMatchup({ arsenal, batters, rowsById, league }) {
  const { cols, minor, totalPa } = pitchColumns(arsenal);
  const hitters = (batters || []).map((b) => {
    const rows = rowsById?.[String(b.player_id)] || [];
    const cells = Object.fromEntries(cols.map((c) => [c.type, cellOf(rows, c.type)]));
    return {
      ...b, rows, cells, hasData: rows.length > 0,
      weighted: { xba: weighted(cells, cols, "xba"), k: weighted(cells, cols, "k") },
    };
  });
  const lineup = lineupRow(hitters, cols);
  const lineupCells = Object.fromEntries(cols.map((c) => [c.type, { ...lineup[c.type] }]));
  return {
    cols, minor, totalPa, hitters,
    lineup: lineupCells,
    lineupWeighted: { xba: weightedPooled(lineupCells, cols, "xba"), k: weightedPooled(lineupCells, cols, "k") },
    leagueWeighted: { xba: leagueWeighted(cols, league, "xba"), k: leagueWeighted(cols, league, "k") },
    league: league || {},
  };
}

// The lineup row is pooled, so its weighted figure uses the pooled sample.
function weightedPooled(cells, cols, metric) {
  return weighted(cells, cols, metric);
}

/** Best and toughest hitter matchups by the weighted figure; null when too few hitters qualify. */
export function rankings(model, metric) {
  const m = METRICS[metric];
  if (!m.weighted) return null;
  const ranked = model.hitters.filter((h) => h.weighted[metric]?.ok).map((h) => ({ h, v: h.weighted[metric].value }));
  if (ranked.length < 6) return { tooFew: true, n: ranked.length };
  ranked.sort((a, b) => (m.hitterBetter === "high" ? b.v - a.v : a.v - b.v));
  return { best: ranked.slice(0, 3), toughest: ranked.slice(-3).reverse(), n: ranked.length };
}

/**
 * Computed findings, each with the numbers it rests on. A finding whose data
 * is missing is skipped, never filled in.
 */
export function findings(model, { pitcherLast, oppAbbr }) {
  const out = [];
  const main = model.cols.filter((c) => c.usage >= MAIN_USAGE);
  const lg = (type, key) => model.league?.[type]?.[key];
  const pitchWord = (c) => c.name.toLowerCase();

  // 1. Where the lineup swings and misses most, against MLB hitters on the same pitch.
  const whiffGaps = main
    .map((c) => ({ c, v: model.lineup[c.type]?.whiff_pct, l: lg(c.type, "whiff_pct"), n: model.lineup[c.type]?.pitches || 0 }))
    .filter((x) => has(x.v) && has(x.l) && x.n >= MIN_PITCHES);
  if (whiffGaps.length) {
    // Only call a pitch out when the gap is at least WHIFF_GAP points; smaller
    // gaps are reported as "about MLB rates" rather than as a lean.
    const top = whiffGaps.slice().sort((a, b) => (b.v - b.l) - (a.v - a.l))[0];
    const gap = top.v - top.l;
    if (gap >= WHIFF_GAP) {
      out.push({ kind: "whiff", html: `${oppAbbr}'s lineup whiffs most against ${pitcherLast}'s <b>${esc(pitchWord(top.c))}</b>: <b>${top.v.toFixed(1)}%</b> of swings, against <b>${top.l.toFixed(1)}%</b> for MLB hitters on ${esc(plural(top.c))}.` });
    } else if (gap > -WHIFF_GAP) {
      out.push({ kind: "whiff", html: `${oppAbbr}'s lineup whiffs at about MLB rates on ${pitcherLast}'s main pitches: its highest, <b>${top.v.toFixed(1)}%</b> on the ${esc(pitchWord(top.c))}, is within ${WHIFF_GAP} points of the <b>${top.l.toFixed(1)}%</b> MLB hitters post on ${esc(plural(top.c))}.` });
    } else {
      out.push({ kind: "whiff", html: `${oppAbbr}'s lineup whiffs less than MLB hitters on every pitch ${pitcherLast} throws ${MAIN_USAGE}% of the time or more.` });
    }
  }

  // 2. How many hitters miss more than MLB hitters on his best swing-and-miss pitch.
  const missPitch = main.filter((c) => has(c.whiff)).sort((a, b) => b.whiff - a.whiff)[0];
  if (missPitch && has(lg(missPitch.type, "whiff_pct"))) {
    const l = lg(missPitch.type, "whiff_pct");
    const q = model.hitters.filter((h) => qualifies(h.cells[missPitch.type], "whiff"));
    if (q.length >= 3) {
      const above = q.filter((h) => h.cells[missPitch.type].whiff_pct > l).length;
      out.push({ kind: "count", html: `<b>${above} of ${q.length}</b> hitters with ${MIN_PITCHES}+ ${esc(plural(missPitch))} seen whiff more often than the MLB average (<b>${l.toFixed(1)}%</b>) against them. It is ${pitcherLast}'s top swing-and-miss pitch at <b>${missPitch.whiff.toFixed(1)}%</b>.` });
    }
  }

  // 3. The strongest single xBA matchup against his most-used pitch.
  const lead = model.cols[0];
  if (lead) {
    const q = model.hitters.filter((h) => qualifies(h.cells[lead.type], "xba"));
    if (q.length >= 3) {
      const best = q.slice().sort((a, b) => b.cells[lead.type].est_ba - a.cells[lead.type].est_ba)[0];
      const r = best.cells[lead.type];
      const l = lg(lead.type, "est_ba");
      out.push({ kind: "best", html: `<b>${esc(best.name)}</b> has the lineup's best xBA against ${pitcherLast}'s ${esc(pitchWord(lead))}, his most-used pitch: <b>${fmt3(r.est_ba)}</b> over ${r.pa} PA${has(l) ? `, against <b>${fmt3(l)}</b> for MLB hitters` : ""}.` });
    }
  }

  // 4. The lineup as a whole against his mix.
  const lw = model.lineupWeighted.xba, lgw = model.leagueWeighted.xba;
  if (lw?.ok && has(lgw)) {
    out.push({ kind: "mix", html: `Weighted by the pitches ${pitcherLast}'s plate appearances end on, the lineup's xBA is <b>${fmt3(lw.value)}</b>, against <b>${fmt3(lgw)}</b> for an MLB-average hitter.` });
  }
  return out;
}

const fmt3 = (v) => Number(v).toFixed(3).replace(/^0/, "");
const plural = (c) => {
  const n = c.name.toLowerCase();
  if (/fastball$/.test(n)) return n.replace(/fastball$/, "fastballs");
  if (/ball$/.test(n)) return `${n}s`;
  return n.endsWith("s") ? n : `${n}s`;
};
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
