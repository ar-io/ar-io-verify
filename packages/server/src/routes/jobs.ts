import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { requireTenant, getTenant } from '../middleware/tenant.js';
import { enqueue } from '../pipeline/job-worker.js';
import * as jobs from '../storage/jobs.js';

const router: RouterType = Router();

router.use(requireTenant());

const TX_ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
// Conservative cap. At ~50 bytes/txId in JSON, 50k IDs ≈ 2.5 MB — well under
// the 16 MB body limit configured in index.ts. Bumped here without bumping
// the body limit will produce confusing 413s before zod runs.
const MAX_TX_IDS_PER_JOB = 50_000;

// Bound the Idempotency-Key so it can't bloat the unique index. Per the
// IETF RFC draft, implementations can require this to be a UUID; we accept
// any printable ASCII up to 128 chars so callers can pass UUIDs, KSUIDs,
// or composite keys.
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,128}$/;

const CreateJobBody = z.object({
  txIds: z.array(z.string().regex(TX_ID_PATTERN)).min(1).max(MAX_TX_IDS_PER_JOB),
});

/**
 * POST /api/v1/jobs
 * Create a verification job for a list of txIds. Returns 202 + { jobId }.
 *
 * Idempotency-Key header is honored — a repeated POST with the same key
 * returns the same jobId without enqueueing a duplicate.
 */
router.post('/', (req, res) => {
  const tenant = getTenant(req);
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.format() });
    return;
  }

  const idempotencyKey = req.header('idempotency-key') ?? null;
  if (idempotencyKey !== null && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    res.status(400).json({ error: 'invalid_idempotency_key' });
    return;
  }
  const result = jobs.createJob({
    tenantId: tenant.tenantId,
    idempotencyKey,
    inputType: 'txIds',
    inputSpec: { ids: parsed.data.txIds },
    totalCount: parsed.data.txIds.length,
  });

  if (!result.deduplicated) {
    enqueue(result.job.id);
  }

  logger.info(
    {
      jobId: result.job.id,
      tenantId: tenant.tenantId,
      count: parsed.data.txIds.length,
      deduplicated: result.deduplicated,
    },
    'Job created'
  );

  res.status(202).json({
    jobId: result.job.id,
    status: result.job.status,
    deduplicated: result.deduplicated,
  });
});

/**
 * GET /api/v1/jobs/events?since=<eventId>&limit=N
 * Pull-based event stream for the calling tenant. Replaces push webhooks.
 */
router.get('/events', (req, res) => {
  const tenant = getTenant(req);
  const sinceRaw = req.query.since;
  const limitRaw = req.query.limit;
  const sinceId = typeof sinceRaw === 'string' ? Number(sinceRaw) : undefined;
  const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;

  if (sinceId !== undefined && (!Number.isFinite(sinceId) || sinceId < 0)) {
    res.status(400).json({ error: 'invalid_since' });
    return;
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    res.status(400).json({ error: 'invalid_limit' });
    return;
  }

  const page = jobs.listEventsForTenant(tenant.tenantId, { sinceId, limit });
  res.json({ items: page.items, nextCursor: page.nextCursor });
});

/**
 * GET /api/v1/jobs/:id
 * Job + latest run status for the tenant. 404 (no leak) if the id belongs
 * to a different tenant.
 */
router.get('/:id', (req, res) => {
  const tenant = getTenant(req);
  const job = jobs.findJobOwnedByTenant(req.params.id, tenant.tenantId);
  if (!job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }

  const run = jobs.getLatestRunForJob(job.id);
  const counters = run
    ? {
        verified: run.verifiedCount,
        tampered: run.failedCount,
        unavailable: run.unavailableCount,
        cacheHit: run.cacheHitCount,
        bytesFetched: run.bytesFetched,
      }
    : null;

  const remaining = run
    ? Math.max(0, job.totalCount - run.verifiedCount - run.failedCount - run.unavailableCount)
    : job.totalCount;

  // Throughput-based ETA: avg ms-per-tx since startedAt × remaining.
  let etaMs: number | null = null;
  if (run && run.status === 'running' && remaining > 0) {
    const done = run.verifiedCount + run.failedCount + run.unavailableCount;
    const elapsed = Date.now() - run.startedAt;
    if (done > 0) {
      etaMs = Math.round((elapsed / done) * remaining);
    }
  }

  res.json({
    job: {
      id: job.id,
      status: job.status,
      totalCount: job.totalCount,
      createdAt: job.createdAt,
      idempotencyKey: job.idempotencyKey,
    },
    run: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          counters,
          remaining,
          etaMs,
          summaryBundleId: run.summaryBundleId,
        }
      : null,
  });
});

/**
 * GET /api/v1/jobs/:id/results
 * Cursor-paginated per-tx outcomes for the job's latest run.
 */
router.get('/:id/results', (req, res) => {
  const tenant = getTenant(req);
  const job = jobs.findJobOwnedByTenant(req.params.id, tenant.tenantId);
  if (!job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }
  const run = jobs.getLatestRunForJob(job.id);
  if (!run) {
    res.json({ items: [], nextCursor: null });
    return;
  }

  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const limitRaw = req.query.limit;
  const limit = typeof limitRaw === 'string' ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    res.status(400).json({ error: 'invalid_limit' });
    return;
  }
  const outcomeRaw = req.query.outcome;
  let outcome: jobs.ResultOutcome | undefined;
  if (typeof outcomeRaw === 'string') {
    if (outcomeRaw !== 'verified' && outcomeRaw !== 'tampered' && outcomeRaw !== 'unavailable') {
      res.status(400).json({ error: 'invalid_outcome' });
      return;
    }
    outcome = outcomeRaw;
  }

  const page = jobs.listResults(run.id, { cursor, limit, outcome });
  res.json({ runId: run.id, items: page.items, nextCursor: page.nextCursor });
});

/**
 * GET /api/v1/jobs/:id/report
 * Returns the signed verification bundle for the latest completed run.
 * Content-negotiated by Accept header — JSON is primary; PDF is a future
 * secondary view rendered from the same bundle.
 */
router.get('/:id/report', (req, res) => {
  const tenant = getTenant(req);
  const job = jobs.findJobOwnedByTenant(req.params.id, tenant.tenantId);
  if (!job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }
  const run = jobs.getLatestRunForJob(job.id);
  if (!run || run.status !== 'completed' || !run.summaryBundleId) {
    res.status(404).json({
      error: 'no_completed_run',
      hint:
        run && run.status === 'running'
          ? 'Run still in progress — retry once status is completed.'
          : undefined,
    });
    return;
  }
  const bundle = jobs.getBundle(run.summaryBundleId);
  if (!bundle) {
    res.status(404).json({ error: 'bundle_missing' });
    return;
  }

  const accept = req.header('accept') ?? '';
  if (accept.includes('application/pdf')) {
    // PDF view of the same bundle — secondary, rendered from the canonical
    // JSON. Not in MVP; returns 406 until the renderer ships.
    res.status(406).json({
      error: 'pdf_not_implemented',
      hint: 'Request Accept: application/json for the verifiable bundle.',
    });
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="verify-bundle-${job.id}-${run.id}.json"`
  );
  // The stored string IS the canonical JSON — send it verbatim so verifiers
  // can hash/verify byte-for-byte without re-serialization risk.
  res.send(bundle.bundleJson);
});

/**
 * DELETE /api/v1/jobs/:id
 * Soft-cancel: marks status='cancelled'. The worker checks this between
 * txs and exits cleanly; recorded results stay queryable.
 */
router.delete('/:id', (req, res) => {
  const tenant = getTenant(req);
  const job = jobs.findJobOwnedByTenant(req.params.id, tenant.tenantId);
  if (!job) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    res.status(409).json({ error: 'job_terminal', status: job.status });
    return;
  }
  jobs.updateJobStatus(job.id, 'cancelled');
  logger.info({ jobId: job.id, tenantId: tenant.tenantId }, 'Job cancellation requested');
  res.json({ jobId: job.id, status: 'cancelled' });
});

export default router;
