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
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_results (
      id TEXT PRIMARY KEY,
      tx_id TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_verification_results_tx_id
    ON verification_results(tx_id)
  `);

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
 * Persist a verification result.
 *
 * Only permanent outcomes (verified / tampered) are cached. Transient failures
 * — gateway timeouts, 5xx, missing binary headers — are NOT persisted, so
 * future re-verifications retry instead of replaying a stale "unavailable"
 * answer. Without this, the cache would suppress exactly the change-detection
 * signal that makes scheduled re-verification valuable. (Task #19)
 */
export function saveResult(result: VerificationResult): void {
  if (!isPermanentOutcome(result)) {
    return;
  }
  const stmt = getDb().prepare(
    'INSERT OR REPLACE INTO verification_results (id, tx_id, result_json, created_at) VALUES (?, ?, ?, ?)'
  );
  stmt.run(result.verificationId, result.txId, JSON.stringify(result), result.timestamp);
}

/**
 * Get the most recent cached result for a tx that is "usable" — i.e. a
 * permanent outcome safe to reuse without re-verifying. Used by the job
 * worker as its cache lookup. Defense-in-depth: even though saveResult
 * already filters, this filter protects against legacy rows.
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
