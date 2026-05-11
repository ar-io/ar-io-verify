import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { VerificationResult } from '../../src/types.js';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    JOB_WORKER_CONCURRENCY: 4,
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_STALL_MS: 60_000,
    JOB_STALL_CHECK_INTERVAL_MS: 60_000,
    SHUTDOWN_DRAIN_MS: 5_000,
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Slow mocked verifier so a job is genuinely in-flight when we call drain.
let verifierResolver: ((txId: string) => void) | null = null;
const verifierBlockers: Array<{ txId: string; release: () => void }> = [];

vi.mock('../../src/pipeline/orchestrator.js', () => ({
  runVerification: async ({ txId }: { txId: string }) => {
    await new Promise<void>((resolve) => {
      verifierBlockers.push({ txId, release: () => resolve() });
      verifierResolver?.(txId);
    });
    return makeOk(txId);
  },
}));

function makeOk(txId: string): VerificationResult {
  return {
    verificationId: `vrf_${txId}`,
    timestamp: new Date().toISOString(),
    txId,
    level: 3,
    existence: { status: 'confirmed', blockHeight: 100, blockTimestamp: null, blockId: null },
    authenticity: {
      status: 'signature_verified',
      signatureValid: true,
      signatureSkipReason: null,
      dataHash: 'h',
      gatewayHash: 'h',
      hashMatch: true,
    },
    owner: { address: 'addr', publicKey: null, addressVerified: true },
    metadata: { dataSize: 10, contentType: null, tags: [] },
    bundle: { isBundled: false, rootTransactionId: null },
    gatewayAssessment: { verified: null, stable: null, trusted: null, hops: null },
    attestation: null,
    links: { dashboard: null, pdf: null, rawData: null },
  };
}

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let cacheModule: typeof import('../../src/storage/cache.js') | null = null;
let workerModule: typeof import('../../src/pipeline/job-worker.js') | null = null;

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

describeIfAvailable('graceful drain', () => {
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
    verifierBlockers.length = 0;
    verifierResolver = null;
    const db = dbModule!.getDb();
    db.exec(
      'DELETE FROM job_events; DELETE FROM verification_bundles; DELETE FROM job_results; DELETE FROM job_runs; DELETE FROM jobs; DELETE FROM verification_results;'
    );
  });

  it('drainInflight refuses new enqueues and waits for in-flight runs to finish', async () => {
    const { job: holdJob } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['hold_tx'] },
      totalCount: 1,
    });

    // Start the job; verifier will block until we release.
    const runPromise = workerModule!.runJob(holdJob.id);

    // Wait until the verifier is actually called (and thus the job is in-flight).
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (verifierBlockers.length > 0) return resolve();
        setTimeout(tick, 5);
      };
      tick();
    });
    expect(workerModule!.inflightJobCount()).toBe(1);

    // Kick off drain — it must NOT resolve while the verifier is still blocking.
    const drainPromise = workerModule!.drainInflight(2_000);

    // Enqueues during drain are refused. Create a second job and call enqueue;
    // the worker should leave its status as 'pending' (not run).
    const { job: refused } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['refused_tx'] },
      totalCount: 1,
    });
    workerModule!.enqueue(refused.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(jobsModule!.findJobById(refused.id)!.status).toBe('pending');

    // Now release the in-flight verifier — drain should clean up.
    verifierBlockers.forEach((b) => b.release());
    await runPromise;
    const remaining = await drainPromise;
    expect(remaining).toBe(0);
    expect(workerModule!.inflightJobCount()).toBe(0);
  });
});
