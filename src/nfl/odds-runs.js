// NFL ODDS RUNS: the run ledger in D1 (table nfl_odds_runs), which is also the
// lock that keeps two refreshes from calling the provider at the same time.
//
// Why D1 and not KV: KV has no conditional write. Two invocations that both
// read "nothing is running" from KV would both go ahead. D1 executes one SQL
// statement atomically, so a conditional INSERT is a real test-and-set.
//
// What the guarantee is, exactly: no attempt can start within `minIntervalMs`
// of the START of another attempt, whether that one succeeded, failed or was
// killed. A run is bounded well inside that interval (at most max_requests
// provider calls, each with a timeout), so two runs never overlap. The claim
// is made before the first provider request and is never released early.

export const RUN_KEEP_DAYS = 14;

/**
 * Claims the right to call the provider. Returns true for exactly one of any
 * set of invocations whose start times fall inside the minimum interval.
 */
export async function claimRun(db, { runId, startedAt, source, minIntervalMs }) {
  const notAfter = new Date(Date.parse(startedAt) - minIntervalMs).toISOString();
  const res = await db.prepare(
    "INSERT INTO nfl_odds_runs (run_id, started_at, kind, outcome, source) " +
    "SELECT ?, ?, 'attempt', 'started', ? " +
    "WHERE NOT EXISTS (SELECT 1 FROM nfl_odds_runs WHERE kind = 'attempt' AND started_at > ?)"
  ).bind(runId, startedAt, source, notAfter).run();
  return (res?.meta?.changes ?? 0) === 1;
}

/** Completes an attempt row with what the run did. */
export async function finishRun(db, { runId, finishedAt, outcome, reason = null, requests = null, providerLeft = null, detail = null }) {
  await db.prepare("UPDATE nfl_odds_runs SET finished_at = ?, outcome = ?, reason = ?, requests = ?, provider_requests_left = ?, detail_json = ? WHERE run_id = ?")
    .bind(finishedAt, outcome, reason, requests, providerLeft, detail == null ? null : JSON.stringify(detail), runId).run();
}

/** A run that did not call the provider, and why. */
export async function recordSkip(db, { runId, at, reason, source }) {
  await db.prepare("INSERT INTO nfl_odds_runs (run_id, started_at, finished_at, kind, outcome, reason, source) VALUES (?, ?, ?, 'skip', 'skipped', ?, ?)")
    .bind(runId, at, at, reason, source).run();
}

/** Drops ledger rows older than RUN_KEEP_DAYS. */
export async function pruneRuns(db, nowMs) {
  await db.prepare("DELETE FROM nfl_odds_runs WHERE started_at < ?").bind(new Date(nowMs - RUN_KEEP_DAYS * 86400_000).toISOString()).run();
}
