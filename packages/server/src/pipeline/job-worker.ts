import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { createLimit } from '../utils/limit.js';
import { runVerification } from './orchestrator.js';
import { mapOutcome } from './outcome.js';
import { buildBundle, bundleToCanonicalJson } from './bundle.js';
import { saveResult, getMostRecentPermanentResult } from '../storage/cache.js';
import * as jobs from '../storage/jobs.js';

/**
 * In-process worker pool for verification jobs.
 *
 * Concurrency model: a per-job concurrency cap (config.JOB_WORKER_CONCURRENCY,
 * default 8) controls fan-out within a single job. The global gateway budget
 * (gateway/budget.ts) is the actual ceiling on outbound fetches and is shared
 * across all jobs and ad-hoc /verify requests.
 *
 * State machine:
 *   pending → running → completed | failed | cancelled
 *
 * Crash safety: on boot, sweepStaleRunning() resets running→pending; the
 * resumePending() call below re-enqueues those jobs. Within a resumed run,
 * already-recorded results are skipped (task #20: partial-run resume).
 *
 * Cancellation: setting jobs.status='cancelled' (via DELETE /jobs/:id, task
 * #17) causes the per-tx loop to short-circuit cleanly — no mid-tx kill.
 */

const PER_JOB_CONCURRENCY = config.JOB_WORKER_CONCURRENCY ?? 8;

const inflightJobs = new Set<string>();

/**
 * Schedule a job to run. Fire-and-forget — the caller does NOT await.
 * Idempotent: a duplicate enqueue while the same job is in flight is a no-op.
 */
export function enqueue(jobId: string): void {
  if (inflightJobs.has(jobId)) {
    logger.debug({ jobId }, 'enqueue ignored: job already in-flight');
    return;
  }
  // No await — let the caller continue. Errors get logged below.
  void runJob(jobId).catch((err) => {
    logger.error({ err, jobId }, 'Job worker exited unexpectedly');
  });
}

/**
 * Re-enqueue any pending jobs left from a previous process or batch creation.
 * Called once at startup, after sweepStaleRunning() has reset stale 'running'
 * rows.
 */
export function resumePending(): number {
  const pending = jobs.listPendingJobs();
  for (const job of pending) {
    enqueue(job.id);
  }
  if (pending.length > 0) {
    logger.info({ count: pending.length }, 'Resumed pending jobs from durable queue');
  }
  return pending.length;
}

/**
 * Run a job to completion (or cancellation/failure). Returns when the run
 * has reached a terminal state. Production code uses enqueue() instead, which
 * fires-and-forgets; this is exported for tests and for any caller that
 * legitimately wants to await completion.
 */
export async function runJob(jobId: string): Promise<void> {
  inflightJobs.add(jobId);
  try {
    const job = jobs.findJobById(jobId);
    if (!job) {
      logger.error({ jobId }, 'Job not found at run start');
      return;
    }
    if (job.status === 'cancelled' || job.status === 'completed' || job.status === 'failed') {
      logger.info({ jobId, status: job.status }, 'Skipping run: job already terminal');
      return;
    }

    jobs.updateJobStatus(jobId, 'running');

    // Reuse the latest in-progress run for resume; otherwise start a fresh one.
    let run = jobs.getLatestRunForJob(jobId);
    if (!run || run.status !== 'running') {
      run = jobs.startRun(jobId);
    }

    const completed = jobs.getCompletedTxIds(run.id);
    const txIds = job.inputSpec.ids.filter((id) => !completed.has(id));

    if (completed.size > 0) {
      logger.info(
        { jobId, runId: run.id, alreadyDone: completed.size, remaining: txIds.length },
        'Resuming partial run'
      );
    }

    const limit = createLimit(PER_JOB_CONCURRENCY);
    let cancelled = false;

    try {
      await Promise.all(
        txIds.map((txId) =>
          limit(async () => {
            if (cancelled) return;
            const fresh = jobs.findJobById(jobId);
            if (fresh?.status === 'cancelled') {
              cancelled = true;
              return;
            }
            await processOne(run!.id, txId);
          })
        )
      );

      // Final status check — caller may have cancelled mid-flight.
      const final = jobs.findJobById(jobId);
      if (final?.status === 'cancelled' || cancelled) {
        jobs.cancelRun(run.id);
        jobs.recordEvent({
          tenantId: job.tenantId,
          jobId,
          runId: run.id,
          type: 'run.cancelled',
          payload: summaryPayload(run.id),
        });
        return;
      }

      // Build + sign the verifiable bundle. Persist it before flipping the
      // run/job status so a successful status implies a retrievable artifact.
      const bundle = buildBundle(jobId, run.id);
      let bundleId: string | null = null;
      if (bundle) {
        const saved = jobs.saveBundle(run.id, bundleToCanonicalJson(bundle));
        bundleId = saved.id;
      }
      jobs.completeRun(run.id, bundleId);
      jobs.updateJobStatus(jobId, 'completed');
      jobs.recordEvent({
        tenantId: job.tenantId,
        jobId,
        runId: run.id,
        type: 'run.completed',
        payload: { ...summaryPayload(run.id), bundleId },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      logger.error({ err, jobId, runId: run.id }, 'Run failed unexpectedly');
      jobs.failRun(run.id, reason);
      jobs.updateJobStatus(jobId, 'failed');
      jobs.recordEvent({
        tenantId: job.tenantId,
        jobId,
        runId: run.id,
        type: 'run.failed',
        payload: { ...summaryPayload(run.id), reason },
      });
    }
  } finally {
    inflightJobs.delete(jobId);
  }
}

async function processOne(runId: string, txId: string): Promise<void> {
  // Cache check first — permanent results never need re-verification.
  const cached = getMostRecentPermanentResult(txId);
  if (cached) {
    const m = mapOutcome(cached);
    jobs.recordResult({
      jobRunId: runId,
      txId,
      verificationId: cached.verificationId,
      outcome: m.outcome,
      cacheHit: true,
      failureReason: m.failureReason,
    });
    jobs.bumpRunCounters(runId, {
      verified: m.outcome === 'verified' ? 1 : 0,
      failed: m.outcome === 'tampered' ? 1 : 0,
      unavailable: m.outcome === 'unavailable' ? 1 : 0,
      cacheHit: 1,
    });
    return;
  }

  try {
    const result = await runVerification({ txId });
    const m = mapOutcome(result);
    saveResult(result); // No-op for transient unavailables (task #19).
    jobs.recordResult({
      jobRunId: runId,
      txId,
      verificationId: result.verificationId,
      outcome: m.outcome,
      cacheHit: false,
      failureReason: m.failureReason,
    });
    jobs.bumpRunCounters(runId, {
      verified: m.outcome === 'verified' ? 1 : 0,
      failed: m.outcome === 'tampered' ? 1 : 0,
      unavailable: m.outcome === 'unavailable' ? 1 : 0,
      bytesFetched: result.metadata.dataSize ?? 0,
    });
  } catch (err) {
    // Pipeline shouldn't normally throw — runVerification handles its own
    // errors and emits a not-found / level-1 result. But guard against bugs.
    logger.error({ err, txId, runId }, 'Verification threw — recording as unavailable');
    jobs.recordResult({
      jobRunId: runId,
      txId,
      verificationId: null,
      outcome: 'unavailable',
      cacheHit: false,
      failureReason: 'unknown',
    });
    jobs.bumpRunCounters(runId, { unavailable: 1 });
  }
}

// ---------------------------------------------------------------------------
// Stall detector (task #18)
// ---------------------------------------------------------------------------

let stallTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic check for runs that have made no progress for too long and force
 * them to terminal status. Without this, a wedged gateway request can leave
 * a job in 'running' indefinitely.
 *
 * Idempotent. No-op if already started.
 */
export function startStallDetector(): void {
  if (stallTimer) return;
  const intervalMs = config.JOB_STALL_CHECK_INTERVAL_MS ?? 60_000;
  stallTimer = setInterval(checkStalledOnce, intervalMs);
  // Don't pin the event loop — let the process exit if all other work is done.
  if (typeof stallTimer.unref === 'function') stallTimer.unref();
  logger.info({ intervalMs }, 'Stall detector started');
}

export function stopStallDetector(): void {
  if (stallTimer) {
    clearInterval(stallTimer);
    stallTimer = null;
  }
}

/**
 * Single pass of the detector. Exported for tests so they can drive timing
 * deterministically.
 */
export function checkStalledOnce(): number {
  const stallMs = config.JOB_STALL_MS ?? 5 * 60_000;
  const stalled = jobs.findStalledRuns(stallMs);
  for (const run of stalled) {
    const job = jobs.findJobById(run.jobId);
    if (!job) continue;
    logger.warn(
      { jobId: job.id, runId: run.id, lastProgressAt: run.lastProgressAt },
      'Detected stalled run — failing'
    );
    jobs.failRun(run.id, 'stalled');
    jobs.updateJobStatus(job.id, 'failed');
    jobs.recordEvent({
      tenantId: job.tenantId,
      jobId: job.id,
      runId: run.id,
      type: 'run.failed',
      payload: { reason: 'stalled', ...summaryPayload(run.id) },
    });
  }
  return stalled.length;
}

function summaryPayload(runId: string): Record<string, unknown> {
  const r = jobs.getRun(runId);
  if (!r) return {};
  return {
    totals: {
      verified: r.verifiedCount,
      tampered: r.failedCount,
      unavailable: r.unavailableCount,
      cacheHit: r.cacheHitCount,
      bytesFetched: r.bytesFetched,
    },
  };
}
