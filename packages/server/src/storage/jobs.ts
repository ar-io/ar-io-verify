import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type ResultOutcome = 'verified' | 'tampered' | 'unavailable';
export type JobInputType = 'txIds';

export type FailureReason =
  | 'signature_mismatch'
  | 'tx_id_mismatch'
  | 'data_hash_mismatch'
  | 'gateway_timeout'
  | 'gateway_5xx'
  | 'gateway_404'
  | 'binary_header_unavailable'
  | 'data_too_large'
  | 'no_signature'
  | 'job_cancelled'
  | 'unknown';

export interface JobInputSpec {
  ids: string[];
}

export interface Job {
  id: string;
  tenantId: string;
  idempotencyKey: string | null;
  inputType: JobInputType;
  inputSpec: JobInputSpec;
  scheduleCron: string | null;
  totalCount: number;
  status: JobStatus;
  createdAt: number;
  retentionDays: number;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  lastProgressAt: number;
  status: RunStatus;
  verifiedCount: number;
  failedCount: number;
  unavailableCount: number;
  cacheHitCount: number;
  bytesFetched: number;
  blockWatermark: number | null;
  summaryBundleId: string | null;
  failureReason: string | null;
}

export interface JobResult {
  jobRunId: string;
  txId: string;
  verificationId: string | null;
  outcome: ResultOutcome;
  cacheHit: boolean;
  failureReason: FailureReason | null;
}

export interface JobEvent {
  id: number;
  tenantId: string;
  jobId: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface VerificationBundle {
  id: string;
  jobRunId: string;
  bundleJson: string;
  createdAt: number;
}

interface RunCounterDeltas {
  verified?: number;
  failed?: number;
  unavailable?: number;
  cacheHit?: number;
  bytesFetched?: number;
}

// ---------------------------------------------------------------------------
// Row-shape helpers (snake_case ↔ camelCase)
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  input_type: string;
  input_spec: string;
  schedule_cron: string | null;
  total_count: number;
  status: string;
  created_at: number;
  retention_days: number;
}

interface RunRow {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  last_progress_at: number;
  status: string;
  verified_count: number;
  failed_count: number;
  unavailable_count: number;
  cache_hit_count: number;
  bytes_fetched: number;
  block_watermark: number | null;
  summary_bundle_id: string | null;
  failure_reason: string | null;
}

interface ResultRow {
  job_run_id: string;
  tx_id: string;
  verification_id: string | null;
  outcome: string;
  cache_hit: number;
  failure_reason: string | null;
}

interface EventRow {
  id: number;
  tenant_id: string;
  job_id: string;
  run_id: string | null;
  type: string;
  payload: string;
  created_at: number;
}

interface BundleRow {
  id: string;
  job_run_id: string;
  bundle_json: string;
  created_at: number;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    idempotencyKey: r.idempotency_key,
    inputType: r.input_type as JobInputType,
    inputSpec: JSON.parse(r.input_spec) as JobInputSpec,
    scheduleCron: r.schedule_cron,
    totalCount: r.total_count,
    status: r.status as JobStatus,
    createdAt: r.created_at,
    retentionDays: r.retention_days,
  };
}

function rowToRun(r: RunRow): JobRun {
  return {
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    lastProgressAt: r.last_progress_at ?? r.started_at,
    status: r.status as RunStatus,
    verifiedCount: r.verified_count,
    failedCount: r.failed_count,
    unavailableCount: r.unavailable_count,
    cacheHitCount: r.cache_hit_count,
    bytesFetched: r.bytes_fetched,
    blockWatermark: r.block_watermark,
    summaryBundleId: r.summary_bundle_id,
    failureReason: r.failure_reason,
  };
}

function rowToResult(r: ResultRow): JobResult {
  return {
    jobRunId: r.job_run_id,
    txId: r.tx_id,
    verificationId: r.verification_id,
    outcome: r.outcome as ResultOutcome,
    cacheHit: r.cache_hit === 1,
    failureReason: r.failure_reason as FailureReason | null,
  };
}

function rowToEvent(r: EventRow): JobEvent {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    jobId: r.job_id,
    runId: r.run_id,
    type: r.type,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

function rowToBundle(r: BundleRow): VerificationBundle {
  return {
    id: r.id,
    jobRunId: r.job_run_id,
    bundleJson: r.bundle_json,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export function initJobsStore(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      idempotency_key TEXT,
      input_type      TEXT NOT NULL,
      input_spec      TEXT NOT NULL,
      schedule_cron   TEXT,
      total_count     INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      retention_days  INTEGER NOT NULL DEFAULT 30
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_tenant_created ON jobs(tenant_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_tenant_idempotency
      ON jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS job_runs (
      id                 TEXT PRIMARY KEY,
      job_id             TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      started_at         INTEGER NOT NULL,
      finished_at        INTEGER,
      last_progress_at   INTEGER NOT NULL,
      status             TEXT NOT NULL,
      verified_count     INTEGER NOT NULL DEFAULT 0,
      failed_count       INTEGER NOT NULL DEFAULT 0,
      unavailable_count  INTEGER NOT NULL DEFAULT 0,
      cache_hit_count    INTEGER NOT NULL DEFAULT 0,
      bytes_fetched      INTEGER NOT NULL DEFAULT 0,
      block_watermark    INTEGER,
      summary_bundle_id  TEXT,
      failure_reason     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_job ON job_runs(job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_status_progress ON job_runs(status, last_progress_at);

    CREATE TABLE IF NOT EXISTS job_results (
      job_run_id      TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
      tx_id           TEXT NOT NULL,
      verification_id TEXT,
      outcome         TEXT NOT NULL,
      cache_hit       INTEGER NOT NULL DEFAULT 0,
      failure_reason  TEXT,
      PRIMARY KEY (job_run_id, tx_id)
    );

    CREATE INDEX IF NOT EXISTS idx_results_outcome ON job_results(job_run_id, outcome);

    CREATE TABLE IF NOT EXISTS job_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      job_id      TEXT NOT NULL,
      run_id      TEXT,
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_tenant_id ON job_events(tenant_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_job ON job_events(job_id);

    CREATE TABLE IF NOT EXISTS verification_bundles (
      id          TEXT PRIMARY KEY,
      job_run_id  TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
      bundle_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bundles_run ON verification_bundles(job_run_id);
  `);

  // Idempotent column-add for in-place upgrades from earlier dev schema.
  // SQLite errors if the column already exists — silently ignore that.
  try {
    db.exec('ALTER TABLE job_runs ADD COLUMN last_progress_at INTEGER');
  } catch {
    // Column already exists.
  }

  logger.info('Jobs store initialized');
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  tenantId: string;
  idempotencyKey: string | null;
  inputType: JobInputType;
  inputSpec: JobInputSpec;
  totalCount: number;
}

export interface CreateJobResult {
  job: Job;
  deduplicated: boolean;
}

export function createJob(input: CreateJobInput): CreateJobResult {
  const db = getDb();

  if (input.idempotencyKey) {
    const existing = db
      .prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?`)
      .get(input.tenantId, input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      return { job: rowToJob(existing), deduplicated: true };
    }
  }

  const job: Job = {
    id: `job_${nanoid(16)}`,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    inputType: input.inputType,
    inputSpec: input.inputSpec,
    scheduleCron: null,
    totalCount: input.totalCount,
    status: 'pending',
    createdAt: Date.now(),
    retentionDays: 30,
  };

  db.prepare(
    `INSERT INTO jobs (id, tenant_id, idempotency_key, input_type, input_spec,
                       schedule_cron, total_count, status, created_at, retention_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.tenantId,
    job.idempotencyKey,
    job.inputType,
    JSON.stringify(job.inputSpec),
    job.scheduleCron,
    job.totalCount,
    job.status,
    job.createdAt,
    job.retentionDays
  );

  return { job, deduplicated: false };
}

export function findJobById(id: string): Job | null {
  const row = getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function findJobOwnedByTenant(id: string, tenantId: string): Job | null {
  const row = getDb()
    .prepare(`SELECT * FROM jobs WHERE id = ? AND tenant_id = ?`)
    .get(id, tenantId) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export interface ListJobsOptions {
  cursor?: { createdAt: number; id: string };
  limit?: number;
  status?: JobStatus;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export function listJobsForTenant(tenantId: string, opts: ListJobsOptions = {}): PageResult<Job> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const db = getDb();

  let rows: JobRow[];
  if (opts.cursor) {
    if (opts.status) {
      rows = db
        .prepare(
          `SELECT * FROM jobs
           WHERE tenant_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
             AND status = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .all(
          tenantId,
          opts.cursor.createdAt,
          opts.cursor.createdAt,
          opts.cursor.id,
          opts.status,
          limit + 1
        ) as JobRow[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM jobs
           WHERE tenant_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .all(
          tenantId,
          opts.cursor.createdAt,
          opts.cursor.createdAt,
          opts.cursor.id,
          limit + 1
        ) as JobRow[];
    }
  } else {
    if (opts.status) {
      rows = db
        .prepare(
          `SELECT * FROM jobs WHERE tenant_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(tenantId, opts.status, limit + 1) as JobRow[];
    } else {
      rows = db
        .prepare(
          `SELECT * FROM jobs WHERE tenant_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .all(tenantId, limit + 1) as JobRow[];
    }
  }

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToJob);
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeJobCursor({ createdAt: last.createdAt, id: last.id }) : null;
  return { items, nextCursor };
}

export function encodeJobCursor(c: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeJobCursor(s: string): { createdAt: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf-8'));
    if (typeof parsed?.createdAt === 'number' && typeof parsed?.id === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function updateJobStatus(id: string, status: JobStatus): void {
  getDb().prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, id);
}

export function listPendingJobs(): Job[] {
  const rows = getDb()
    .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC`)
    .all() as JobRow[];
  return rows.map(rowToJob);
}

/**
 * On boot, reset any jobs that were marked 'running' when the process died so
 * the worker pool re-enqueues them. The associated run rows stay in 'running'
 * status — `runJob` reuses them and `getCompletedTxIds(run.id)` correctly
 * skips already-recorded txIds (real partial-run resume).
 *
 * `last_progress_at` is bumped to now so the stall detector doesn't
 * immediately fail a run that just got picked back up.
 */
export function sweepStaleRunning(): { jobs: number; runs: number } {
  const db = getDb();
  const jobsResult = db
    .prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`)
    .run();
  const runsResult = db
    .prepare(`UPDATE job_runs SET last_progress_at = ? WHERE status = 'running'`)
    .run(Date.now());
  return { jobs: jobsResult.changes, runs: runsResult.changes };
}

/**
 * Delete jobs older than `retentionMs` along with their cascaded runs/results/
 * bundles, plus events older than the same cutoff. Caller is responsible for
 * scheduling. Returns counts deleted (for logging).
 */
export function pruneOldJobs(retentionMs: number): { jobs: number; events: number } {
  const cutoff = Date.now() - retentionMs;
  const db = getDb();
  // ON DELETE CASCADE on job_runs / job_results / verification_bundles
  // takes care of the transitive cleanup.
  const j = db.prepare(`DELETE FROM jobs WHERE created_at < ?`).run(cutoff);
  // job_events has no FK back to jobs (events outlive their jobs by design),
  // so prune by age explicitly.
  const e = db.prepare(`DELETE FROM job_events WHERE created_at < ?`).run(cutoff);
  return { jobs: j.changes, events: e.changes };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function startRun(jobId: string): JobRun {
  const db = getDb();
  const now = Date.now();
  const run: JobRun = {
    id: `run_${nanoid(16)}`,
    jobId,
    startedAt: now,
    finishedAt: null,
    lastProgressAt: now,
    status: 'running',
    verifiedCount: 0,
    failedCount: 0,
    unavailableCount: 0,
    cacheHitCount: 0,
    bytesFetched: 0,
    blockWatermark: null,
    summaryBundleId: null,
    failureReason: null,
  };
  db.prepare(
    `INSERT INTO job_runs (id, job_id, started_at, last_progress_at, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(run.id, run.jobId, run.startedAt, run.lastProgressAt, run.status);
  return run;
}

export function getRun(runId: string): JobRun | null {
  const row = getDb().prepare(`SELECT * FROM job_runs WHERE id = ?`).get(runId) as
    | RunRow
    | undefined;
  return row ? rowToRun(row) : null;
}

export function getLatestRunForJob(jobId: string): JobRun | null {
  const row = getDb()
    .prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(jobId) as RunRow | undefined;
  return row ? rowToRun(row) : null;
}

/**
 * All terminal-state transitions are conditional on the run still being
 * 'running' so concurrent transitions (worker complete + stall detector +
 * cancellation) can't trample each other. Returns true if the transition
 * actually happened.
 */
export function completeRun(runId: string, summaryBundleId: string | null): boolean {
  const r = getDb()
    .prepare(
      `UPDATE job_runs
       SET status = 'completed', finished_at = ?, summary_bundle_id = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(Date.now(), summaryBundleId, runId);
  return r.changes > 0;
}

export function failRun(runId: string, reason: string): boolean {
  const r = getDb()
    .prepare(
      `UPDATE job_runs SET status = 'failed', finished_at = ?, failure_reason = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(Date.now(), reason, runId);
  return r.changes > 0;
}

export function cancelRun(runId: string): boolean {
  const r = getDb()
    .prepare(
      `UPDATE job_runs SET status = 'cancelled', finished_at = ?, failure_reason = 'job_cancelled'
       WHERE id = ? AND status = 'running'`
    )
    .run(Date.now(), runId);
  return r.changes > 0;
}

/**
 * Bump per-run counters. No-op if the run is no longer 'running' — prevents
 * a late-arriving processOne from mutating a cancelled or completed run.
 */
export function bumpRunCounters(runId: string, deltas: RunCounterDeltas): void {
  getDb()
    .prepare(
      `UPDATE job_runs
       SET verified_count    = verified_count    + ?,
           failed_count      = failed_count      + ?,
           unavailable_count = unavailable_count + ?,
           cache_hit_count   = cache_hit_count   + ?,
           bytes_fetched     = bytes_fetched     + ?,
           last_progress_at  = ?
       WHERE id = ? AND status = 'running'`
    )
    .run(
      deltas.verified ?? 0,
      deltas.failed ?? 0,
      deltas.unavailable ?? 0,
      deltas.cacheHit ?? 0,
      deltas.bytesFetched ?? 0,
      Date.now(),
      runId
    );
}

/**
 * Find runs that are still 'running' but have made no progress (no counter
 * bumps) for at least `stallMs` milliseconds. Used by the stall detector to
 * fail wedged jobs (task #18).
 */
export function findStalledRuns(stallMs: number): JobRun[] {
  const cutoff = Date.now() - stallMs;
  const rows = getDb()
    .prepare(`SELECT * FROM job_runs WHERE status = 'running' AND last_progress_at < ?`)
    .all(cutoff) as RunRow[];
  return rows.map(rowToRun);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RecordResultInput {
  jobRunId: string;
  txId: string;
  verificationId: string | null;
  outcome: ResultOutcome;
  cacheHit: boolean;
  failureReason: FailureReason | null;
}

/**
 * Record a per-tx outcome. Only inserts if the run is still 'running' — late-
 * arriving results from in-flight verifies that started before cancellation
 * are dropped rather than silently appearing under a cancelled run.
 */
export function recordResult(input: RecordResultInput): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO job_results
        (job_run_id, tx_id, verification_id, outcome, cache_hit, failure_reason)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM job_runs WHERE id = ? AND status = 'running')`
    )
    .run(
      input.jobRunId,
      input.txId,
      input.verificationId,
      input.outcome,
      input.cacheHit ? 1 : 0,
      input.failureReason,
      input.jobRunId
    );
}

export interface ListResultsOptions {
  cursor?: string;
  limit?: number;
  outcome?: ResultOutcome;
}

export function listResults(
  jobRunId: string,
  opts: ListResultsOptions = {}
): PageResult<JobResult> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const db = getDb();
  let rows: ResultRow[];
  if (opts.outcome && opts.cursor) {
    rows = db
      .prepare(
        `SELECT * FROM job_results WHERE job_run_id = ? AND outcome = ? AND tx_id > ?
         ORDER BY tx_id ASC LIMIT ?`
      )
      .all(jobRunId, opts.outcome, opts.cursor, limit + 1) as ResultRow[];
  } else if (opts.outcome) {
    rows = db
      .prepare(
        `SELECT * FROM job_results WHERE job_run_id = ? AND outcome = ?
         ORDER BY tx_id ASC LIMIT ?`
      )
      .all(jobRunId, opts.outcome, limit + 1) as ResultRow[];
  } else if (opts.cursor) {
    rows = db
      .prepare(
        `SELECT * FROM job_results WHERE job_run_id = ? AND tx_id > ?
         ORDER BY tx_id ASC LIMIT ?`
      )
      .all(jobRunId, opts.cursor, limit + 1) as ResultRow[];
  } else {
    rows = db
      .prepare(`SELECT * FROM job_results WHERE job_run_id = ? ORDER BY tx_id ASC LIMIT ?`)
      .all(jobRunId, limit + 1) as ResultRow[];
  }

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToResult);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.txId : null;
  return { items, nextCursor };
}

export function getCompletedTxIds(jobRunId: string): Set<string> {
  const rows = getDb()
    .prepare(`SELECT tx_id FROM job_results WHERE job_run_id = ?`)
    .all(jobRunId) as { tx_id: string }[];
  return new Set(rows.map((r) => r.tx_id));
}

export function listFailuresForRun(jobRunId: string, limit = 100): JobResult[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM job_results
       WHERE job_run_id = ? AND outcome IN ('tampered', 'unavailable')
       ORDER BY tx_id ASC LIMIT ?`
    )
    .all(jobRunId, limit) as ResultRow[];
  return rows.map(rowToResult);
}

/**
 * List `verified` rows for a run, joined with the cached per-tx
 * VerificationResult so the bundle builder can extract the audit-relevant
 * fields (hash, owner, block, recovery offsets) without an N+1 lookup.
 *
 * `result_json` may be null if the cache row was pruned by the 30-day
 * cleanup. Callers should skip rows with null result_json and log — by
 * the time the bundle is built (immediately on run completion) the row
 * is expected to be present, but defensive handling matters at scale.
 */
export function listVerifiedForRun(
  jobRunId: string,
  limit = 50_000
): Array<{ txId: string; verificationId: string | null; resultJson: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT r.tx_id AS tx_id, r.verification_id AS verification_id, v.result_json AS result_json
         FROM job_results r
         LEFT JOIN verification_results v ON v.id = r.verification_id
        WHERE r.job_run_id = ? AND r.outcome = 'verified'
        ORDER BY r.tx_id ASC
        LIMIT ?`
    )
    .all(jobRunId, limit) as Array<{
    tx_id: string;
    verification_id: string | null;
    result_json: string | null;
  }>;
  return rows.map((r) => ({
    txId: r.tx_id,
    verificationId: r.verification_id,
    resultJson: r.result_json,
  }));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface RecordEventInput {
  tenantId: string;
  jobId: string;
  runId: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export function recordEvent(input: RecordEventInput): JobEvent {
  const createdAt = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO job_events (tenant_id, job_id, run_id, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.tenantId,
      input.jobId,
      input.runId,
      input.type,
      JSON.stringify(input.payload),
      createdAt
    );
  return {
    id: Number(result.lastInsertRowid),
    tenantId: input.tenantId,
    jobId: input.jobId,
    runId: input.runId,
    type: input.type,
    payload: input.payload,
    createdAt,
  };
}

export interface ListEventsOptions {
  sinceId?: number;
  limit?: number;
}

export function listEventsForTenant(
  tenantId: string,
  opts: ListEventsOptions = {}
): PageResult<JobEvent> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const db = getDb();
  const sinceId = opts.sinceId ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM job_events WHERE tenant_id = ? AND id > ?
       ORDER BY id ASC LIMIT ?`
    )
    .all(tenantId, sinceId, limit + 1) as EventRow[];

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEvent);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? String(last.id) : null;
  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export function saveBundle(jobRunId: string, bundleJson: string): VerificationBundle {
  const bundle: VerificationBundle = {
    id: `bndl_${nanoid(16)}`,
    jobRunId,
    bundleJson,
    createdAt: Date.now(),
  };
  getDb()
    .prepare(
      `INSERT INTO verification_bundles (id, job_run_id, bundle_json, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(bundle.id, bundle.jobRunId, bundle.bundleJson, bundle.createdAt);
  return bundle;
}

export function getBundle(id: string): VerificationBundle | null {
  const row = getDb().prepare(`SELECT * FROM verification_bundles WHERE id = ?`).get(id) as
    | BundleRow
    | undefined;
  return row ? rowToBundle(row) : null;
}

export function getBundleByRunId(jobRunId: string): VerificationBundle | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM verification_bundles WHERE job_run_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(jobRunId) as BundleRow | undefined;
  return row ? rowToBundle(row) : null;
}
