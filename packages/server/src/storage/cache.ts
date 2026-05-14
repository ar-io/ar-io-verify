import { logger } from '../utils/logger.js';
import { getDb, initDb } from './db.js';
import { isPermanentOutcome } from '../pipeline/outcome.js';
import type { VerificationResult } from '../types.js';

const CACHE_MAX_AGE_DAYS = 30;
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function initCache(): void {
  // Idempotent — initDb() returns the existing connection if already opened
  // by another store (e.g., the jobs store).
  initDb();
  // The `verification_results` table is created in storage/db.ts:initDb()
  // so it exists whenever the DB is open — bundle.ts joins against it.
  pruneExpired();
  cleanupTimer = setInterval(pruneExpired, CLEANUP_INTERVAL_MS);

  logger.info('Verification cache initialized');
}

function pruneExpired(): void {
  try {
    const result = getDb()
      .prepare(`DELETE FROM verification_results WHERE created_at < datetime('now', ?)`)
      .run(`-${CACHE_MAX_AGE_DAYS} days`);
    if (result.changes > 0) {
      logger.info({ deleted: result.changes }, 'Pruned expired verification results');
    }
  } catch (error) {
    logger.error({ error }, 'Failed to prune expired results');
  }
}

/**
 * Persist a verification result. ALL outcomes are persisted — including
 * transient `unavailable` results — so the single-tx PDF endpoint can
 * render a certificate for every verification attempt, not just successful
 * ones.
 *
 * Change-detection semantics are preserved at READ time, not write time:
 * the worker's cache lookup goes through `getMostRecentPermanentResult()`
 * which filters for permanent outcomes only. A stored `unavailable`
 * therefore never short-circuits a re-verification — it is just retrievable
 * by its verificationId for as long as the row lives.
 *
 * (Prior to V2 the filter was at the write site, which silently 404'd the
 * PDF endpoint for unverified outcomes — a UX bug. The lookup-time filter
 * is the load-bearing one for change-detection.)
 */
export function saveResult(result: VerificationResult): void {
  const stmt = getDb().prepare(
    'INSERT OR REPLACE INTO verification_results (id, tx_id, result_json, created_at) VALUES (?, ?, ?, ?)'
  );
  stmt.run(result.verificationId, result.txId, JSON.stringify(result), result.timestamp);
}

/**
 * Get the most recent cached result for a tx that is "usable" — i.e. a
 * permanent outcome safe to reuse without re-verifying. Used by the job
 * worker as its cache lookup. THIS is the load-bearing filter for the
 * change-detection signal: scheduled re-verifications never replay a
 * stored `unavailable` because this filter rejects it. (Task #19)
 */
export function getMostRecentPermanentResult(txId: string): VerificationResult | null {
  const all = getResultsByTxId(txId);
  for (const r of all) {
    if (isPermanentOutcome(r)) return r;
  }
  return null;
}

export function getResultById(verificationId: string): VerificationResult | null {
  const row = getDb()
    .prepare('SELECT result_json FROM verification_results WHERE id = ?')
    .get(verificationId) as { result_json: string } | undefined;

  if (!row) return null;
  return JSON.parse(row.result_json) as VerificationResult;
}

export function getResultsByTxId(txId: string): VerificationResult[] {
  const rows = getDb()
    .prepare(
      'SELECT result_json FROM verification_results WHERE tx_id = ? ORDER BY created_at DESC'
    )
    .all(txId) as { result_json: string }[];

  return rows.map((row) => JSON.parse(row.result_json) as VerificationResult);
}

export function closeCache(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
