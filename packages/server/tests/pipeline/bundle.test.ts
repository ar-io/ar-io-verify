import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    SQLITE_PATH: ':memory:',
    GATEWAY_HOST: 'gateway.test',
    GATEWAY_MAX_INFLIGHT: 32,
    JOB_WORKER_CONCURRENCY: 2,
    SIGNING_KEY_PATH: '',
  },
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

let dbModule: typeof import('../../src/storage/db.js') | null = null;
let jobsModule: typeof import('../../src/storage/jobs.js') | null = null;
let bundleModule: typeof import('../../src/pipeline/bundle.js') | null = null;
let signingModule: typeof import('../../src/utils/signing.js') | null = null;

try {
  const Database = (await import('better-sqlite3')).default;
  new Database(':memory:').close();
  dbModule = await import('../../src/storage/db.js');
  jobsModule = await import('../../src/storage/jobs.js');
  bundleModule = await import('../../src/pipeline/bundle.js');
  signingModule = await import('../../src/utils/signing.js');
} catch {
  // sqlite native binding unavailable
}

const describeIfAvailable = bundleModule ? describe : describe.skip;

describeIfAvailable('verification bundle', () => {
  beforeAll(() => {
    dbModule!.initDb();
    jobsModule!.initJobsStore();
  });

  afterAll(() => {
    dbModule!.closeDb();
  });

  beforeEach(() => {
    const db = dbModule!.getDb();
    db.exec(
      'DELETE FROM job_events; DELETE FROM verification_bundles; DELETE FROM job_results; DELETE FROM job_runs; DELETE FROM jobs;'
    );
  });

  it('builds a bundle with totals, gateway, and tenancy metadata', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1', 't2', 't3'] },
      totalCount: 3,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't1',
      verificationId: 'v1',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't2',
      verificationId: 'v2',
      outcome: 'tampered',
      cacheHit: false,
      failureReason: 'signature_mismatch',
    });
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't3',
      verificationId: null,
      outcome: 'unavailable',
      cacheHit: false,
      failureReason: 'gateway_404',
    });
    jobsModule!.bumpRunCounters(run.id, { verified: 1, failed: 1, unavailable: 1 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    expect(bundle.version).toBe(1);
    expect(bundle.type).toBe('verify.bundle.run');
    expect(bundle.tenantId).toBe('tenant_a');
    expect(bundle.gateway).toBe('gateway.test');
    expect(bundle.totals.verified).toBe(1);
    expect(bundle.totals.tampered).toBe(1);
    expect(bundle.totals.unavailable).toBe(1);
    expect(bundle.totals.total).toBe(3);
    expect(bundle.failures.length).toBe(2); // tampered + unavailable
    expect(bundle.failuresTruncated).toBe(false);
    // No wallet configured → null signature, but payloadHash always present
    expect(bundle.signature).toBeNull();
    expect(bundle.payloadHash).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('canonical JSON is byte-identical across re-builds for the same run', () => {
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.recordResult({
      jobRunId: run.id,
      txId: 't1',
      verificationId: 'v1',
      outcome: 'verified',
      cacheHit: false,
      failureReason: null,
    });
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });
    jobsModule!.completeRun(run.id, null);

    const a = bundleModule!.bundleToCanonicalJson(bundleModule!.buildBundle(job.id, run.id)!);
    const b = bundleModule!.bundleToCanonicalJson(bundleModule!.buildBundle(job.id, run.id)!);
    expect(a).toBe(b);
  });

  it('payloadHash matches independent SHA-256 of canonical bundle minus payloadHash and signature', async () => {
    const { createHash } = await import('node:crypto');
    const { job } = jobsModule!.createJob({
      tenantId: 'tenant_a',
      idempotencyKey: null,
      inputType: 'txIds',
      inputSpec: { ids: ['t1'] },
      totalCount: 1,
    });
    const run = jobsModule!.startRun(job.id);
    jobsModule!.bumpRunCounters(run.id, { verified: 1 });
    jobsModule!.completeRun(run.id, null);

    const bundle = bundleModule!.buildBundle(job.id, run.id)!;
    const { payloadHash, signature, ...unsigned } = bundle;
    const canonical = signingModule!.canonicalize(unsigned as unknown as Record<string, unknown>);
    const expectedHash = createHash('sha256').update(canonical).digest('base64url');
    expect(payloadHash).toBe(expectedHash);
    expect(signature).toBeNull(); // no wallet in this test
  });

  it('returns null when the run does not exist', () => {
    expect(bundleModule!.buildBundle('job_nope', 'run_nope')).toBeNull();
  });
});
