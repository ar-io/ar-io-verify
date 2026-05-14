import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { VerificationResult } from '../../src/types.js';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    JOB_WORKER_CONCURRENCY: 2,
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_STALL_MS: 60_000,
    JOB_STALL_CHECK_INTERVAL_MS: 60_000,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Mock the orchestrator so we can craft outcomes per-tx without real network.
const verifyCalls: string[] = [];
vi.mock('../../src/pipeline/orchestrator.js', () => ({
  runVerification: async (req: { txId: string }) => {
    verifyCalls.push(req.txId);
    return makeResult(req.txId);
  },
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let workerModule: typeof import('../../src/pipeline/job-worker.js') | null = null;
let cacheModule: typeof import('../../src/storage/cache.js') | null = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
  cacheModule = await import('../../src/storage/cache.js');
  workerModule = await import('../../src/pipeline/job-worker.js');
} catch {
  // sqlite native binding unavailable
}

const describeIfAvailable = workerModule ? describe : describe.skip;

/**
 * Encode the desired outcome in the txId so the mocked verifier can produce
 * the right result deterministically:
 *   txId starts with 'ok_'    → verified
 *   txId starts with 'bad_'   → tampered (signature mismatch)
 *   txId starts with 'gone_'  → unavailable (gateway 404)
 */
function makeResult(txId: string): VerificationResult {
  const base: VerificationResult = {
    verificationId: `vrf_${txId}`,
    timestamp: new Date().toISOString(),
    txId,
    level: 1,
    existence: { status: 'confirmed', blockHeight: 100, blockTimestamp: null, blockId: null },
    authenticity: {
      status: 'unverified',
      signatureValid: null,
      signatureSkipReason: null,
      dataHash: null,
      gatewayHash: null,
      hashMatch: null,
      signatureType: null,
      dataRoot: null,
    },
    owner: { address: 'addr', publicKey: null, addressVerified: null },
    metadata: { dataSize: 1024, contentType: null, tags: [] },
    bundle: { isBundled: false, rootTransactionId: null },
    recovery: { arweave: null, dataItem: null },
    gatewayAssessment: { verified: null, stable: null, trusted: null, hops: null },
    attestation: null,
    links: { dashboard: null, pdf: null, rawData: null },
  };
  if (txId.startsWith('ok_')) {
    base.level = 3;
    base.authenticity.status = 'signature_verified';
    base.authenticity.signatureValid = true;
  } else if (txId.startsWith('bad_')) {
    base.level = 2;
    base.authenticity.status = 'unverified';
    base.authenticity.signatureValid = false;
    base.authenticity.signatureSkipReason = 'recovered owner does not match';
  } else if (txId.startsWith('gone_')) {
    base.existence.status = 'not_found';
  }
  return base;
}

describeIfAvailable('job worker', () => {
  beforeAll(() => {
    dbModule!.initDb();
    jobsModule!.initJobsStore();
    cacheModule!.initCache();
  });

  afterAll(() => {
    cacheModule!.closeCache();
    dbModule!.closeDb();
  });

  beforeEach(() => {
    verifyCalls.length = 0;
    const db = dbModule!.getDb();
    db.exec(
      'DELETE FROM job_events; DELETE FROM verification_bundles; DELETE FROM job_results; DELETE FROM job_runs; DELETE FROM jobs; DELETE FROM verification_results;'
    );
  });

  it('runs a small job to completion and aggregates outcome counts', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_1', 'ok_2', 'bad_3', 'gone_4'] },
      totalCount: 4,
    });
    await workerModule!.runJob(job.id);

    const finalJob = jobsModule!.findJobById(job.id)!;
    expect(finalJob.status).toBe('completed');

    const run = jobsModule!.getLatestRunForJob(job.id)!;
    expect(run.status).toBe('completed');
    expect(run.verifiedCount).toBe(2);
    expect(run.failedCount).toBe(1);
    expect(run.unavailableCount).toBe(1);
  });

  it('granular failure reasons land on results', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['bad_1', 'gone_2'] },
      totalCount: 2,
    });
    await workerModule!.runJob(job.id);
    const run = jobsModule!.getLatestRunForJob(job.id)!;
    const results = jobsModule!.listResults(run.id).items;
    const tampered = results.find((r) => r.txId === 'bad_1')!;
    const unavailable = results.find((r) => r.txId === 'gone_2')!;
    expect(tampered.outcome).toBe('tampered');
    expect(tampered.failureReason).toBe('signature_mismatch');
    expect(unavailable.outcome).toBe('unavailable');
    expect(unavailable.failureReason).toBe('gateway_404');
  });

  it('cache hits skip re-verification and bump cacheHit counter', async () => {
    const { job: first } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_a', 'ok_b'] },
      totalCount: 2,
    });
    await workerModule!.runJob(first.id);
    expect(verifyCalls.length).toBe(2);

    const { job: second } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_a', 'ok_b'] },
      totalCount: 2,
    });
    verifyCalls.length = 0;
    await workerModule!.runJob(second.id);
    expect(verifyCalls.length).toBe(0); // both served from cache

    const run = jobsModule!.getLatestRunForJob(second.id)!;
    expect(run.cacheHitCount).toBe(2);
    expect(run.verifiedCount).toBe(2);
  });

  it('does NOT cache transient unavailable outcomes', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['gone_x'] },
      totalCount: 1,
    });
    await workerModule!.runJob(job.id);
    expect(verifyCalls).toEqual(['gone_x']);

    // Re-run a job with the same tx — it must hit the pipeline again because
    // the unavailable outcome should NOT have been cached. (Task #19.)
    verifyCalls.length = 0;
    const { job: again } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['gone_x'] },
      totalCount: 1,
    });
    await workerModule!.runJob(again.id);
    expect(verifyCalls).toEqual(['gone_x']);
  });

  it('emits a run.completed event with totals payload', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_1', 'bad_2'] },
      totalCount: 2,
    });
    await workerModule!.runJob(job.id);

    const events = jobsModule!.listEventsForTenant('tenant_a').items;
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('run.completed');
    const totals = (events[0].payload.totals ?? {}) as Record<string, number>;
    expect(totals.verified).toBe(1);
    expect(totals.tampered).toBe(1);
  });

  it('skips already-recorded txIds on resume (partial-run support)', async () => {
    // Simulate a crashed run: create job, start a run, record one result, leave running.
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_1', 'ok_2', 'ok_3'] },
      totalCount: 3,
    });
    jobsModule!.updateJobStatus(job.id, 'running');
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 'ok_1',
      verificationId: 'vrf_pre',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });

    // Run resume — verify ONLY ok_2 and ok_3 hit the pipeline.
    await workerModule!.runJob(job.id);
    expect(verifyCalls.sort()).toEqual(['ok_2', 'ok_3']);

    const final = jobsModule!.getLatestRunForJob(job.id)!;
    expect(final.status).toBe('completed');
  });

  it('handles a 250-tx job and produces consistent counters + paginated results', async () => {
    const ids = Array.from({ length: 250 }, (_, i) =>
      i % 4 === 0 ? `bad_bulk_${i}` : i % 7 === 0 ? `gone_bulk_${i}` : `ok_bulk_${i}`
    );
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids },
      totalCount: ids.length,
    });
    await workerModule!.runJob(job.id);

    expect(jobsModule!.findJobById(job.id)!.status).toBe('completed');
    const run = jobsModule!.getLatestRunForJob(job.id)!;
    expect(run.verifiedCount + run.failedCount + run.unavailableCount).toBe(250);

    // Walk all pages of the results endpoint and confirm full coverage.
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = jobsModule!.listResults(run.id, { limit: 100, cursor });
      for (const r of page.items) seen.add(r.txId);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(seen.size).toBe(250);
    expect(pages).toBeGreaterThan(1); // proves pagination actually had to advance
  });

  it('resumes after a real crash recovery path (sweep + worker re-pickup)', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_alpha', 'ok_beta', 'ok_gamma'] },
      totalCount: 3,
    });
    // Simulate the worker having processed one tx before the process died.
    jobsModule!.updateJobStatus(job.id, 'running');
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 'ok_alpha',
      verificationId: 'vrf_pre',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });

    // Boot-time recovery: sweep flips the job back to 'pending' but leaves
    // the run alive at 'running' so the worker can resume it.
    jobsModule!.sweepStaleRunning();
    expect(jobsModule!.findJobById(job.id)!.status).toBe('pending');
    expect(jobsModule!.getRun(run.id)!.status).toBe('running');

    await workerModule!.runJob(job.id);
    // Only the two unfinished txs should hit the pipeline.
    expect(verifyCalls.sort()).toEqual(['ok_beta', 'ok_gamma']);

    const final = jobsModule!.getLatestRunForJob(job.id)!;
    expect(final.status).toBe('completed');
    // The pre-crash result is preserved AND counted.
    expect(final.verifiedCount).toBe(3);
  });

  it('stall detector fails runs with no progress past the threshold', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_x'] },
      totalCount: 1,
    });
    jobsModule!.updateJobStatus(job.id, 'running');
    const run = jobsModule!.startRun(job.id);

    // Force last_progress_at into the past beyond the stall threshold.
    const db = dbModule!.getDb();
    db.prepare(`UPDATE job_runs SET last_progress_at = ? WHERE id = ?`).run(
      Date.now() - 10 * 60_000,
      run.id
    );

    const failed = workerModule!.checkStalledOnce();
    expect(failed).toBe(1);

    expect(jobsModule!.getRun(run.id)!.status).toBe('failed');
    expect(jobsModule!.findJobById(job.id)!.status).toBe('failed');
    const events = jobsModule!.listEventsForTenant('tenant_a').items;
    expect(events.some((e) => e.type === 'run.failed' && e.payload.reason === 'stalled')).toBe(
      true
    );
  });

  it('cancellation mid-flight terminates with status=cancelled', async () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['ok_1', 'ok_2', 'ok_3'] },
      totalCount: 3,
    });
    // Cancel before running — the worker checks per-tx and exits cleanly.
    jobsModule!.updateJobStatus(job.id, 'cancelled');
    await workerModule!.runJob(job.id);

    // Worker should not flip to completed when status was cancelled when it started.
    const final = jobsModule!.findJobById(job.id)!;
    expect(final.status).toBe('cancelled');
    // No pipeline calls happen for cancelled-before-start.
    expect(verifyCalls.length).toBe(0);
  });
});
